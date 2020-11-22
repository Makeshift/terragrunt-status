#!/usr/bin/env node
const chalk = require('chalk');
const path = require('path');
const usage = chalk`
Usage: {white ${path.basename(process.argv[1]).split('.js')[0]}} {grey [-h|--help] [--debug] [-r|--refresh] [-d|--deploy-order] [-x|--destroy-order] [<path_to_infrastructure>]}

This tool describes the deployment status of multiple Terragrunt-managed Terrarform stacks.

Where:
  {yellow -h|    --help            }Show this help text
{grey ----}
  {yellow --debug                  }Shows extra output
{grey ----}
  {yellow -d     --deploy-order    }Outputs a legal deploy order for the given stacks
  {yellow -x     --destroy-order   }Outputs a legal destroy order for the given stacks
  {yellow -r     --refresh         }Locks and refreshes statefiles (This will increase the time taken to get a result, but may be more accurate to the live deployment)
{grey ----}
  {yellow <path_to_infrastructure> }Path to your Terragrunt infrastructure definition - If not provided, assumed to be current working directory.

{white Note: If you're using aws-vault, you should run this script in an aws-vault session, with the command:}
  {grey aws-vault exec <profile> -- ./${path.basename(process.argv[1]).split('.js')[0]}}
`;

const dotparser = require('dotparser');
const execa = require('execa');
const Spinnies = require('spinnies');
const { Writable, PassThrough } = require('stream');
const which = require('which');
const toposort = require('toposort');

const argv = require('minimist')(process.argv.slice(2), {
  boolean: true
});
const outputStream = new Writable({
  write(chunk, encoding, callback) {
    if (argv.debug) {
      process.stderr.write(chunk);
    }
    callback();
  }
});

require('events').EventEmitter.defaultMaxListeners = 0;
Error.stackTraceLimit = Infinity;

let terraform, terragrunt;
const cwd = path.resolve(argv._[0] || process.cwd());

async function go() {
  await failEarly();
  const spinnies = new Spinnies();
  console.log(chalk`Checking for Terragrunt files under dir {blue ${cwd}}`);
  const dependencyTree = await getDependencyTree(spinnies);
  if (argv.d || argv['deploy-order'] || argv.x || argv['destroy-order']) {
    if (argv.d || argv['deploy-order']) {
      console.log('The following stacks should be deployed in this order:');
      console.log(dependencyTree.deployOrder.map((dep) => chalk`  * {green ${dep}}`).join('\n'));
    }
    if (argv.x || argv['destroy-order']) {
      console.log('The following stacks should be destroyed in this order:');
      console.log(dependencyTree.destroyOrder.map((dep) => chalk`  * {yellow ${dep}}`).join('\n'));
    }
    console.log('The following stacks can be deployed/destroyed in any order:');
    console.log(dependencyTree.noDeps.map((dep) => chalk`  * {grey ${dep}}`).join('\n'));
    process.exit(0);
  }
  dependencyTree.deployOrder = dependencyTree.deployOrder.concat(dependencyTree.noDeps);
  dependencyTree.destroyOrder = dependencyTree.destroyOrder.concat(dependencyTree.noDeps);
  await getStatusAll(dependencyTree, spinnies);
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
    if (e.message.includes('not found: ')) {
      console.log(chalk`{red ${e.message.split('not found: ')[1]}} {yellow was not found on this system. Is it in your path?}`);
    } else {
      console.log(e);
    }
    process.exit(1);
  }
}

async function getDependencyTree(spinnies) {
  spinnies.add('deptree', { text: 'Getting dependency tree...' });
  try {
    const { stdout } = await execa(terragrunt, ['graph-dependencies'], {
      cwd: cwd
    });
    const parsedGraph = dotparser(stdout);
    const onlyEdges = [
      ...new Set(
        parsedGraph[0].children
          .filter((obj) => obj.type === 'edge_stmt')
          .map((obj) => obj.edge_list)
          .map((arr) => arr.map((ids) => ids.id))
      )
    ];
    const destroyOrder = toposort(onlyEdges);
    const otherNodes = parsedGraph[0].children
      .filter((obj) => obj.type === 'node_stmt')
      .map((obj) => obj.node_id.id)
      .filter((obj) => !destroyOrder.includes(obj));
    const returnVal = {
      destroyOrder: [...destroyOrder],
      deployOrder: [...destroyOrder].reverse(),
      noDeps: otherNodes
    };
    spinnies.succeed('deptree', {
      text: `Getting dependency tree... Done! (${destroyOrder.length + otherNodes.length} stacks)`
    });
    return returnVal;
  } catch (e) {
    spinnies.fail('deptree', `Getting dependency tree... Failed :( ${chalk`{grey (use --debug to show errors from Terragrunt)}`}`);
    if (e.code === 'ENOENT') {
      console.log(chalk`{red We couldn't find the directory }{yellow ${cwd}}. {red Please ensure it exists and that it is being parsed properly. You may need to provide an absolute path.}`);
    } else if (e.message.includes('Could not find any subfolders with Terragrunt configuration files')) {
      console.log(
        chalk`{red We couldn't find any Terragrunt config files in }{yellow ${cwd}}. {red Please ensure it exists and that it is being parsed properly. You may need to provide an absolute path.}`
      );
    } else {
      outputStream.write(e);
    }
    process.exit(1);
  }
}

async function getStatusAll(dependencyTree, spinnies) {
  let results = await Promise.all(
    dependencyTree.deployOrder.map((stack) => {
      let dir = path.resolve(cwd, stack);
      spinnies.add(dir, {
        text: chalk`Checking if {blue ${stack}} is deployed...`
      });
      return getStatus(dir, spinnies, stack);
    })
  );
  results.forEach((result) => {
    if (result.stacktrace) {
      outputStream.write(result.stacktrace);
    }
  });
}

async function getStatus(dir, spinnies, stackName) {
  let ret = {
    isDeployedResult: await isDeployed(dir, spinnies, stackName)
  };
  if (ret.isDeployedResult.deployed) {
    ret.planResult = await getPlan(dir, spinnies, stackName);
  }
  return ret;
}

async function isDeployed(dir, spinnies, stackName) {
  let proc = execa(terragrunt, ['state', 'list'], { cwd: dir });
  const count = new PassThrough();
  proc.stdout.pipe(count);
  proc.stdout.pipe(outputStream);
  proc.stderr.pipe(outputStream);
  let stdout = '';
  count.on('data', (chunk) => (stdout += chunk));
  let error;
  try {
    await proc;
  } catch (e) {
    error = e;
  } finally {
    let ret = {
      deployed: false,
      success: false,
      failReason: '',
      stacktrace: error
    };
    /* jshint ignore:start */
    if (error?.message.includes('but detected no outputs')) {
      ret.failReason = 'Parent stack not deployed.';
    } else if (error?.message.includes('No state file was found!')) {
      ret.failReason = 'No state file found.';
    } else if (ret.stacktrace?.stderr?.includes('Error finding AWS credentials')) {
      ret.failReason = 'Could not find AWS credentials.';
    } else if (ret.stacktrace?.stderr?.includes('Initialization required')) {
      ret.failReason = chalk`Initialization required. Run {yellow terragrunt init} in this folder.`;
    } else if (error) {
      ret.failReason = 'Unknown';
    } else {
      if (proc.exitCode === 0) {
        ret.success = true;
        if (stdout.length > 1) {
          ret.deployed = true;
        }
      }
    }
    /* jshint ignore:end */
    if (ret.deployed) {
      spinnies.update(dir, { text: chalk`{blue ${stackName}} is deployed!` });
    } else if (ret.failReason === 'Parent stack not deployed.') {
      spinnies.update(dir, {
        text: chalk`{blue ${stackName}} may not be deployed! We can't tell due to a Terragrunt error. ( Reason: ${ret.failReason} ) ${chalk`{grey (use --debug to show errors from Terragrunt)}`}`,
        status: 'fail',
        failColor: 'yellow'
      });
    } else {
      spinnies.fail(dir, {
        text: chalk`{blue ${stackName}} is NOT deployed! ${ret.failReason ? `( Reason: ${ret.failReason} )` : ''} ${ret.failReason ? chalk`{grey (use --debug to show errors from Terragrunt)}` : ''}`
      });
    }

    return ret;
  }
}

async function getPlan(dir, spinnies, stackName) {
  spinnies.add(dir, { text: chalk`Getting plan for {blue ${stackName}}...` });
  let tgPlanArgs = ['plan', '-detailed-exitcode', '-compact-warnings'];
  if (!argv.r && !argv.refresh) {
    tgPlanArgs.push('-refresh=false', '-lock=false');
  }
  let proc = execa(terragrunt, tgPlanArgs, { cwd: dir });
  proc.stdout.pipe(outputStream);
  let error;
  try {
    await proc;
  } catch (e) {
    error = e;
  } finally {
    let ret = {
      hasChanges: false,
      success: false,
      stacktrace: error
    };
    if (proc.exitCode === 0) {
      ret.success = true;
    } else if (proc.exitCode === 2) {
      ret.success = true;
      ret.hasChanges = true;
    }
    if (ret.hasChanges) {
      spinnies.update(dir, {
        text: chalk`{blue ${stackName}} has changes in its plan!`,
        status: 'succeed',
        succeedColor: 'yellow'
      });
    } else if (ret.success) {
      spinnies.succeed(dir, {
        text: chalk`{blue ${stackName}} is up to date!`
      });
    } else {
      spinnies.fail(dir, {
        text: chalk`{blue ${stackName}} errored :( ${chalk`{grey (use --debug to show errors from Terragrunt)`}`
      });
    }

    return ret;
  }
}

go();
