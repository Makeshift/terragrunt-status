#!/usr/bin/env node
/*
Known issues:
  If there are no dependencies attached to a stack, it won't show up
*/

const chalk = require('chalk');
const path = require('path');
//{ {white <instance_name> [<output_path>] |} {grey [-l|--list]}
const usage = chalk`
Usage: {white ${path.basename(process.argv[1]).split(".js")[0]}} {grey [-h|--help] [--debug] [<path_to_infrastructure>]}

This tool describes the deployment status of multiple Terragrunt-managed Terrarform stacks.

Where:
  {yellow -h|    --help            }Show this help text
{grey ----}
  {yellow --debug                  }Shows extra output
{grey ----}
  {yellow <path_to_infrastructure> }Path to your Terragrunt infrastructure definition - If not provided, assumed to be current working directory.

{white Note: If you're using aws-vault, you should run this script in an aws-vault session, with the command:}
  {grey aws-vault exec <profile> -- ./${path.basename(process.argv[1]).split(".js")[0]}}
`

const { Spinner } = require('clui');
const dotparser = require('dotparser');
const execa = require('execa');
const inquirer = require("inquirer");
const Spinnies = require("spinnies");
const { Writable, PassThrough } = require('stream');
const which = require('which');
const toposort = require('toposort');

const argv = require('minimist')(process.argv.slice(2), {
  boolean: true
});
const outputStream = new Writable({ write(chunk, encoding, callback) { if (argv.debug) process.stdout.write(chunk); callback(); } })

let terraform, terragrunt;
const cwd = path.resolve(argv._[0] || __dirname);

async function go() {
  await failEarly();
  const spinnies = new Spinnies();
  const dependencyTree = await getDependencyTree(spinnies);
  const status = await getStatusAll(dependencyTree, spinnies);
}

async function failEarly() {
  if (argv.help || argv.h) {
    console.log(usage);
    process.exit(0);
  }
  try {
    let whichResults = await Promise.all([which('terraform'), which('terragrunt')]);
    terraform = whichResults[0];
    terragrunt = whichResults[1];
  } catch (e) {
    if (e.message.includes("not found: ")) {
      console.log(chalk`{red ${e.message.split("not found: ")[1]}} {yellow was not found on this system. Is it in your path?}`)
    } else {
      console.log(e);
    }
    process.exit(1)
  }
}

async function getDependencyTree(spinnies) {
  spinnies.add("deptree", { text: "Getting dependency tree..." })
  try {
    const { stdout } = await execa(terragrunt, ['graph-dependencies'], { cwd: cwd });
    const parsedGraph = dotparser(stdout);
    const onlyEdges = parsedGraph[0].children.filter(obj => obj.type === "edge_stmt").map(obj => obj.edge_list).map(arr => arr.map(ids => ids.id));
    const destroyOrder = toposort(onlyEdges)
    const returnVal = {
      destroyOrder: destroyOrder,
      deployOrder: destroyOrder.reverse()
    }
    spinnies.succeed("deptree", { text: `Getting dependency tree... Done! (${destroyOrder.length} stacks)` })
    return returnVal;
  } catch (e) {
    spinnies.fail("deptree", "Getting dependency tree... Failed :(")
    if (e.code === "ENOENT") {
      console.log(chalk`{red We couldn't find the directory }{yellow ${cwd}}. {red Please ensure it exists and that it is being parsed properly. You may need to provide an absolute path.}`)
    } else if (e.message.includes("Could not find any subfolders with Terragrunt configuration files")) {
      console.log(chalk`{red We couldn't find any Terragrunt config files in }{yellow ${cwd}}. {red Please ensure it exists and that it is being parsed properly. You may need to provide an absolute path.}`)
    } else {
      console.log(e)
    }
    process.exit(1)
  }
}

async function getStatusAll(dependencyTree, spinnies) {
  let results = await Promise.all(dependencyTree.deployOrder.map(stack => getStatus(path.resolve(cwd, stack), spinnies, stack)))
  console.log(results);
}

async function getStatus(dir, spinnies, stackName) {
  let ret = {
    isDeployedResult: await isDeployed(dir, spinnies, stackName)
  }
  if (ret.isDeployedResult.deployed) {
    ret.planResult = await getPlan(dir, spinnies, stackName);
  }
  return ret;
}

async function isDeployed(dir, spinnies, stackName) {
  spinnies.add(dir, { text: `Checking if deployed ${stackName}...` })
  let proc = execa(terragrunt, ['state', 'list'], { cwd: dir });
  const count = new PassThrough();
  proc.stdout.pipe(count);
  proc.stdout.pipe(outputStream);
  let stdout = "";
  count.on('data', chunk => stdout += chunk);
  let error;
  try {
    await proc
  } catch (e) {
    error = e;
  } finally {
    let ret = {
      deployed: false,
      success: false,
      failReason: ""
    }
    if (error) {
      if (error.message.includes("but detected no outputs")) {
        ret.failReason = "Parent stack not deployed."
      } else {
        ret.failReason = "Unknown"
        console.log(error);
      }
    } else {
      if (proc.exitCode === 0) {
        ret.success = true;
        if (stdout.length > 1) ret.deployed = true;
      }
    }
    spinnies.succeed(dir, { text: `Checking if deployed ${stackName}... Done! (Success: ${ret.success} - ${proc.exitCode} ${ret.failReason ? `(Reason: ${ret.failReason})` : ""}) (Deployed result: ${ret.deployed})` })
    return ret;
  }
}

async function getPlan(dir, spinnies, stackName) {
  spinnies.add(dir, { text: `Getting plan for ${stackName}...` })
  let proc = execa(terragrunt, ['plan', '-detailed-exitcode', '-compact-warnings', '-refresh=false', '-lock=false'], { cwd: dir });
  proc.stdout.pipe(outputStream);
  try {
    await proc;
  } catch (e) {
    //Don't really care why it failed - that's for the user to deal with. We simply want to know the exit code.
  } finally {
    let ret = {
      hasChanges: false,
      success: false
    }
    if (proc.exitCode === 0) {
      ret.success = true;
    } else if (proc.exitCode === 2) {
      ret.success = true;
      ret.hasChanges = true;
    }
    spinnies.succeed(dir, { text: `Getting plan for ${stackName}... Done! (Success: ${ret.success} - ${proc.exitCode}) (Has changes: ${ret.hasChanges})` })
    return ret;
  }
}

go();
