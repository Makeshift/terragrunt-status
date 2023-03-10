#!/usr/bin/env node
import chalkTemplate from 'chalk-template'
import { spawn } from 'child_process'
import dotparser from 'dotparser'
import EventEmitter from 'events'
import minimist from 'minimist'
import { createRequire } from 'node:module'
import * as path from 'path'
import Spinnies from 'spinnies'
import { Writable } from 'stream'
import toposort from 'toposort'
import which from 'which'
const require = createRequire(import.meta.url)
const { name: packageName, version: packageVersion } = require('../package.json')

const usage = chalkTemplate`
Usage: {white ${path.basename(process.argv[1]).split('.js')[0]}} {grey [-h|--help] [--debug] [-r|--refresh] [-d|--deploy-order] [-x|--destroy-order] [<path_to_infrastructure>]}

This tool describes the deployment status of multiple Terragrunt-managed Terrarform stacks.

Where:
  {yellow -h|    --help            }Show this help text
  {yellow -v|    --version         }Output version
{grey ----}
  {yellow --debug                  }Shows extra output
{grey ----}
  {yellow -d     --deploy-order    }Outputs a legal deploy order for the given stacks, then exits
  {yellow -x     --destroy-order   }Outputs a legal destroy order for the given stacks, then exits
  {yellow -r     --refresh         }Locks and refreshes statefiles (This will increase the time taken to get a result, but may be more accurate to the live deployment)
{grey ----}
  {yellow <path_to_infrastructure> }Path to your Terragrunt infrastructure definition - If not provided, assumed to be current working directory.

{white Note: If you're using aws-vault, you should run this script in an aws-vault session, with the command:}
  {grey aws-vault exec <profile> -- ${path.basename(process.argv[1])}}
`

const argv = minimist(process.argv.slice(2), {
  boolean: true
})
const outputStream = new Writable({
  write (chunk, encoding, callback) {
    if (argv.debug) {
      process.stderr.write(chalkTemplate`{grey ${chunk.toString()}}`)
    }
    callback()
  }
})

EventEmitter.defaultMaxListeners = 0
Error.stackTraceLimit = Infinity

let terragrunt, terraform
const cwd = path.resolve(argv._[0] || process.cwd())

async function go () {
  await failEarly()
  const spinnies = new Spinnies()
  console.log(chalkTemplate`Checking for Terragrunt files under dir {blue ${cwd}}`)
  const dependencyTree = await getDependencyTree(spinnies)
  if (argv.d || argv['deploy-order'] || argv.x || argv['destroy-order']) {
    if (argv.d || argv['deploy-order']) {
      console.log('The following stacks should be deployed in this order:')
      console.log(dependencyTree.deployOrder.map((dep) => chalkTemplate`  * {green ${dep}}`).join('\n'))
    }
    if (argv.x || argv['destroy-order']) {
      console.log('The following stacks should be destroyed in this order:')
      console.log(dependencyTree.destroyOrder.map((dep) => chalkTemplate`  * {yellow ${dep}}`).join('\n'))
    }
    console.log('The following stacks can be deployed/destroyed in any order:')
    console.log(dependencyTree.noDeps.map((dep) => chalkTemplate`  * {grey ${dep}}`).join('\n'))
    process.exit(0)
  }
  dependencyTree.deployOrder = dependencyTree.deployOrder.concat(dependencyTree.noDeps)
  dependencyTree.destroyOrder = dependencyTree.destroyOrder.concat(dependencyTree.noDeps)
  await getStatusAll(dependencyTree, spinnies)
}

async function failEarly () {
  if (argv.help || argv.h) {
    console.log(usage)
    process.exit(0)
  }
  if (argv.version || argv.v) {
    console.log(`Package: ${packageName}`)
    console.log(`Version: ${packageVersion}`)
    process.exit(0)
  }
  try {
    const whichResults = await Promise.all([which('terraform'), which('terragrunt')])
    terraform = whichResults[0]
    terragrunt = whichResults[1]
  } catch (e) {
    if (e.message.includes('not found: ')) {
      console.log(chalkTemplate`{red ${e.message.split('not found: ')[1]}} {yellow was not found on this system. Is it in your path?}`)
    } else {
      console.log(e)
    }
    process.exit(1)
  }
}

async function getDependencyTree (spinnies) {
  spinnies.add('deptree', { text: 'Getting dependency tree...' })
  try {
    const result = await execProcess(terragrunt, ['graph-dependencies', '--terragrunt-ignore-external-dependencies'], {
      cwd
    })
    const parsedGraph = dotparser(result.stdout)
    const onlyEdges = [
      ...new Set(
        parsedGraph[0].children
          .filter((obj) => obj.type === 'edge_stmt')
          .map((obj) => obj.edge_list)
          .map((arr) => arr.map((ids) => path.relative(cwd, ids.id)))
      )
    ]
    const destroyOrder = toposort(onlyEdges)
    const otherNodes = parsedGraph[0].children
      .filter((obj) => obj.type === 'node_stmt')
      .map((obj) => path.relative(cwd, obj.node_id.id))
      .filter((obj) => !destroyOrder.includes(obj))
    const returnVal = {
      destroyOrder: [...destroyOrder],
      deployOrder: [...destroyOrder].reverse(),
      noDeps: otherNodes
    }
    spinnies.succeed('deptree', {
      text: `Getting dependency tree... Done! (${destroyOrder.length + otherNodes.length} stacks)`
    })
    return returnVal
  } catch (e) {
    spinnies.fail('deptree', `Getting dependency tree... Failed :( ${chalkTemplate`{grey (use --debug to show errors from Terragrunt)}`}`)
    console.log(chalkTemplate`Unfortunately, for {blue terragrunt-status} to run, the command {blue terragrunt graph-dependencies} must exit 0. There is no way to get it to skip erroring stacks.`)
    if (e?.code === 'ENOENT') {
      console.log(chalkTemplate`{red We couldn't find the directory }{yellow ${cwd}}. {red Please ensure it exists and that it is being parsed properly. You may need to provide an absolute path.}`)
    } else if (e?.stderr.includes('Could not find any subfolders with Terragrunt configuration files')) {
      console.log(
        chalkTemplate`{red We couldn't find any Terragrunt config files in }{yellow ${cwd}}. {red Please ensure it exists and that it is being parsed properly. You may need to provide an absolute path.}`
      )
    } else {
      console.log(chalkTemplate`{red Unknown error occurred:}`)
      console.log(chalkTemplate`{blue stdout}:\n${e.stdout.replace('\\n', '\n')}\n{blue stderr}:\n{red ${e.stderr.replace('\\n', '\n')}}\n{blue Exit code:} {red ${e.exitCode}}`)
    }
    process.exit(1)
  }
}

async function getStatusAll (dependencyTree, spinnies) {
  const results = await Promise.all(
    dependencyTree.deployOrder.map((stack) => {
      const dir = path.resolve(cwd, stack)
      spinnies.add(dir, {
        text: chalkTemplate`Checking if {blue ${stack}} is deployed...`
      })
      return getStatus(dir, spinnies, stack)
    })
  )
  results.forEach((result) => {
    if (result.stacktrace) {
      outputStream.write(result.stacktrace)
    }
  })
}

async function getStatus (dir, spinnies, stackName) {
  const ret = {
    isDeployedResult: await isDeployed(dir, spinnies, stackName)
  }
  if (ret.isDeployedResult.deployed) {
    ret.planResult = await getPlan(dir, spinnies, stackName)
  }
  return ret
}

async function execProcess (file, args, opts = {}, rejectIfExitNonzero = true) {
  return new Promise((resolve, reject) => {
    const run = spawn(file, args, opts)
    const ret = {
      stdout: '',
      stderr: '',
      exitCode: 255
    }
    let error
    run.stderr.on('data', (data) => {
      ret.stderr += data
      outputStream.write(data)
    })
    run.stdout.on('data', (data) => {
      ret.stdout += data
      outputStream.write(data)
    })
    run.on('error', (err) => {
      console.log(chalkTemplate`{red ${err}}`)
      error = err
    })
    run.on('close', (code) => {
      ret.exitCode = code || 0
      if (error) Object.assign(error, ret)
      if (code !== 0 && rejectIfExitNonzero) {
        reject(ret)
      } else {
        ret.err = error
        resolve(ret)
      }
    })
  })
}

async function isDeployed (dir, spinnies, stackName) {
  const result = await execProcess(terragrunt, ['state', 'list'], { cwd: dir }, false)

  const ret = {
    deployed: false,
    success: false
  }
  if (result.stderr.includes('No state file was found!')) {
    ret.failReason = 'No state file found.'
    spinnies.fail(dir, {
      text: chalkTemplate`{blue ${stackName}} is NOT deployed! ( Reason: ${ret.failReason} )${chalkTemplate`{grey (use --debug to show errors from Terragrunt)}`}`
    })
    return ret
  }

  if (result.stderr.includes('but detected no outputs')) {
    ret.failReason = 'Parent stack not deployed.'
  } else if (result.stderr.includes('Error finding AWS credentials')) {
    ret.failReason = 'Could not find AWS credentials.'
  } else if (result.stderr.includes('Initialization required') || result.stderr.includes('Could not load plugin')) {
    ret.failReason = chalkTemplate`Initialization required. Run {yellow terragrunt init} in this folder.`
  } else if (result.exitCode !== 0) {
    ret.failReason = 'Unknown'
  } else {
    ret.success = true
    if (result.stdout.split('\n').length > 1) {
      ret.deployed = true
      spinnies.update(dir, { text: chalkTemplate`{blue ${stackName}} is deployed!` })
    } else {
      ret.failReason = 'Terragrunt exited zero, but Terraform did not output anything from "terragrunt state list".'
    }
  }
  if (ret.failReason) {
    spinnies.update(dir, {
      text: chalkTemplate`{blue ${stackName}} may not be deployed! We can't tell due to a Terragrunt error. ( Reason: ${ret.failReason} ) ${chalkTemplate`{grey (use --debug to show errors from Terragrunt)}`}`,
      status: 'fail',
      failColor: 'yellow'
    })
  }
  return ret
}

async function getPlan (dir, spinnies, stackName) {
  spinnies.add(dir, { text: chalkTemplate`Getting plan for {blue ${stackName}}...` })
  const tgPlanArgs = ['plan', '-detailed-exitcode', '-compact-warnings']
  if (!argv.r && !argv.refresh) {
    tgPlanArgs.push('-refresh=false', '-lock=false')
  }
  const result = await execProcess(terragrunt, tgPlanArgs, { cwd: dir }, false)

  const ret = {
    hasChanges: false,
    success: false
  }
  if (result.exitCode === 0) {
    ret.success = true
    spinnies.succeed(dir, {
      text: chalkTemplate`{blue ${stackName}} is up to date!`
    })
  } else if (result.exitCode === 2) {
    ret.success = true
    ret.hasChanges = true
    spinnies.update(dir, {
      text: chalkTemplate`{blue ${stackName}} has changes in its plan!`,
      status: 'succeed',
      succeedColor: 'yellow',
      succeedPrefix: 'F'
    })
  } else {
    spinnies.fail(dir, {
      text: chalkTemplate`{blue ${stackName}} errored :( ${chalkTemplate`{grey (use --debug to show errors from Terragrunt)}`}`
    })
  }

  return ret
}

process.on('unhandledRejection', (err, p) => {
  console.log('Unhandled Rejection at: Promise', p, 'reason:', err)
  console.log(err.stack || err)
})

go()
