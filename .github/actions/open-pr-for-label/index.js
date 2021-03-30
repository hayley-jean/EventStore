const core = require('@actions/core');
const github = require('@actions/github');

const fs = require('fs');
// See https://git-scm.com/docs/git-cherry-pick for more details.
const { cherryPickCommits } = require("github-cherry-pick");

const { Octokit } = require('@octokit/rest');
const auth = core.getInput('github-token');
const octokit = new Octokit({
  auth
});
const owner = 'hayley-jean';
const repo = 'EventStore';

const validLabels = ['beta', 'stable'];
const trackingLabel = 'tracking';

async function getPullRequestOnIssue(issueBody) {
  const index = issueBody.indexOf("#");
  const pullNumber = issueBody.substring(index + 1);
  console.log(`Pull request number: ${pullNumber}`);

  const pullRequest = await octokit.pulls.get({
    repo,
    owner,
    pull_number: pullNumber
  });
  return pullRequest.data;
}

async function getLastCommit(branch) {
    // Workaround for https://github.com/octokit/rest.js/issues/1506
    const urlToGet = `GET /repos/${owner}/${repo}/git/refs/heads/${branch}`;
    const branchInfo = await octokit.request(urlToGet, {
      repo,
      owner,
      branch
      });

    if (branchInfo.status != 200) {
      throw `Failed to get branch branch details for '${branch}' : ${JSON.stringify(branchInfo)}`;
    }
    return branchInfo.data.object.sha;
}

async function createNewBranch(branchName, targetSha) {
    const branchRef = `refs/heads/${branchName}`;

    const response = await octokit.git.createRef({
      owner,
      repo,
      ref: branchRef,
      sha: targetSha
    })
    if (response.status != 201) {
      throw `Failed to create new branch: ${JSON.stringify(response)}`;
    }
    return branchRef;
}

async function getCommitShasInPr(pullNumber) {
    const pullRequestCommits = await octokit.pulls.listCommits({
      owner,
      repo,
      pull_number: pullNumber,
    });
    if (pullRequestCommits.status != 200) {
      throw `Failed to get commits on PR ${pullNumber}: ${JSON.stringify(response)}`;
    }

    return pullRequestCommits.data.map(c => c.sha);
}

async function cherryPick(commitShas, branchName) {
    const newHeadSha = await cherryPickCommits({
      commits: commitShas,
      head: branchName,
      octokit,
      owner,
      repo,
    });
    console.log(`New head after cherry pick: ${newHeadSha}`);
    return newHeadSha;
}

async function createPullRequest(title, head, base, body) {
    const result = await octokit.pulls.create({
      owner,
      repo,
      title,
      body,
      head,
      base
    });
    console.log(`Pull request was created ${result}`);
}

async function commentOnIssueForPr(issueNumber, body) {
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body
  });
}

async function run() {
  try {
    const payload = github.context.payload;
    console.log(JSON.stringify(payload, undefined, 2));

    // const payloadFile = fs.readFileSync( 'C:\\Scratch\\github_issue_context.json');
    // console.log(payloadFile.toString());
    // const payload = JSON.parse(payloadFile.toString()).event;

    const issue = payload.issue;
    const label = payload.label.name;

    if (!validLabels.includes(label)) {
      throw `Invalid label applied: '${label}'`;
    }
    if (!issue.labels.map(x => x.name).includes(trackingLabel)) {
      throw `Issue does not have a tracking label`;
    }

    const pullRequest= await getPullRequestOnIssue(issue.body);

    const targetBranch = label;
    console.log(`The target branch is ${targetBranch}`);

    console.log(`Getting latest commit for branch ${targetBranch}`);
    const targetSha = await getLastCommit(targetBranch);

    const newBranchName = `${pullRequest.head.ref}-${targetBranch}`;
    console.log(`Creating a branch ${newBranchName} with sha ${targetSha}`);
    const newBranchRef = await createNewBranch(newBranchName, targetSha);

    console.log(`Getting commits for PR ${pullRequest.number}`)
    const commitShas = await getCommitShasInPr(pullRequest.number);

    try {

      console.log(`Cherry picking commits '${commitShas}' on '${newBranchName}'`);
      const newHeadSha = await cherryPick(commitShas, newBranchName);

      const newTitle = `[${targetBranch}] ${pullRequest.title}`;

      console.log(`Opening a PR against ${targetBranch}, with head ${newHeadSha} on ${newBranchRef} and title '${newTitle}'`);
      const prBody = `Tracked by ${payload.owner.name}/${payload.repository.name}#${issue.number}`;
      await createPullRequest(newTitle, newBranchRef, targetBranch, prBody);
      console.log('Pull request has been opened');

    } catch (ex) {

      console.log(`Failed to cherry-pick commits due to error '${ex}'`);
      console.log('Updating tracking issue with cherry-pick error');
      var newBody = `PR Promotion to ${label} failed due to '${ex}'.\nCommits to be cherry-picked:\n`;
      for (var i = 0; i < commitShas.length; i++) {
        newBody += `${commitShas[i]}\n`;
      }
      await commentOnIssueForPr(issue.number, newBody);

    }

  } catch (error) {
    core.setFailed(error.message);
  }
}

run();