# terragrunt-status

![CircleCI](https://img.shields.io/circleci/build/github/Makeshift/terragrunt-status)
![npm](https://img.shields.io/npm/dw/terragrunt-status)
![GitHub issues](https://img.shields.io/github/issues/Makeshift/terragrunt-status)
![npm](https://img.shields.io/npm/v/terragrunt-status)
[![Depfu](https://badges.depfu.com/badges/1300925fe7391773fe6f266fc2ebc06d/overview.svg)](https://depfu.com/github/Makeshift/terragrunt-status?project_id=17813)

terragrunt-status is a small script that tells you which stacks in Terragrunt are deployed, and if they are out of date.

![A recording of terragrunt-status in use](recording.gif)

## What it can do

- When ran in a folder containing Terragrunt-managed infrastructure, it will retrieve the dependency graph
- It will then check the output of `terragrunt state list` in each folder to check if it is deployed
- If the stack is deployed, it will check the output of `terragrunt plan -detailed-exitcode -compact-warnings -refresh=false -lock=false` to see if the stack code is up to date with the state. (Note: It does not refresh the statefile by default. This can be overridden with `--refresh`)
- Will display this information

## What it WILL do (eventually)

- Show the information prettily
- Will handle different edge-cases and errors from Terragrunt/Terraform
- Will be able to generate `apply-all` and `destroy-all` commands that exclude deployed/non-deployed stacks (to work around issues like terragrunt-io/terragrunt#1394)

## What it MIGHT do (if there's interest / if I end up needing it)

- Optionally will be able to run things like `terragrunt init` if it's needed
- Be able to iterate through stacks in order and run commands as a wrapper around Terragrunt
- Maybe have a cool interactive CLI menu with tickboxes and stuff to choose stacks and then it'll do it in the right order with dependencies and stuff? I dunno I haven't thought that far ahead.

## Installation

### NPM

- `npm install -g terragrunt-status`

### Manual

- `git clone https://github.com/Makeshift/terragrunt-status`
- `cd terragrunt-status`
- `npm install --production` (if you forget `--production` you'll be downloading a lot more packages!)
- Run `./terragrunt-status.js <dir>`

## Usage

```text
Usage: terragrunt-status [-h|--help] [--debug] [-r|--refresh] [-d|--deploy-order] [-x|--destroy-order] [<path_to_infrastructure>]

This tool describes the deployment status of multiple Terragrunt-managed Terrarform stacks.

Where:
  -h|    --help            Show this help text
----
  --debug                  Shows extra output
----
  -d     --deploy-order    Outputs a legal deploy order for the given stacks, then exits
  -x     --destroy-order   Outputs a legal destroy order for the given stacks, then exits
  -r     --refresh         Locks and refreshes statefiles (This will increase the time taken to get a result, but may be more accurate to the live deployment)
----
  <path_to_infrastructure> Path to your Terragrunt infrastructure definition - If not provided, assumed to be current working directory.

Note: If you're using aws-vault, you should run this script in an aws-vault session, with the command:
  aws-vault exec <profile> -- terragrunt-status.js
```

## Known issues

- The code is ugly and not particularly efficient (I wrote it in a hurry)
- The output is pretty meh, but workable.
