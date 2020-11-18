# terragrunt-status

terragrunt-status is a small script that tells you which stacks in Terragrunt are deployed, and if they are out of date.

# What it can do

* When ran in a folder containing Terragrunt-managed infrastructure, it will retrieve the dependency graph
* It will then check the output of `terragrunt state list` in each folder to check if it is deployed
* If the stack is deployed, it will check the output of `terragrunt plan -detailed-exitcode -compact-warnings -refresh=false -lock=false` to see if the stack is up to date
* Will display this information

# What it WILL do (eventually)

* Show the information prettily
* Will handle different edge-cases and errors from Terragrunt/Terraform
* Will be able to generate `apply-all` and `destroy-all` commands that exclude deployed/non-deployed stacks (to work around issues like terragrunt-io/terragrunt#1394)

# Installation

(TODO: npm & docker)

* Clone the repo
* Run `./terragrunt-status.js <dir>`

# Known issues

* It currently only traverses the dependency graph as produced by Terragrunt - If there is no dependency graph (eg. no dependencies or only one stack) then it won't work
