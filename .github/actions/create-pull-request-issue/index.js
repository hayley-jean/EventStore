const core = require('@actions/core');
const github = require('@actions/github');

const fs = require('fs');

const { Octokit } = require('@octokit/rest');
const auth = core.getInput('github-token');
const octokit = new Octokit({
  auth
});
const owner = 'hayley-jean';
const repo = 'EventStore';
const validBranches = ["master", "beta", "stable"];

async function createIssueForPr(prTitle, assignees, body) {
  const title = `[Tracking] ${prTitle}`;
  await octokit.issues.create({
    owner,
    repo,
    title,
    assignees,
    body,
    labels: ["tracking"]
  });
}

function getTrackingIssueNumberForPr(prBody) {
  if (!prBody) throw "Merged PR does not have a body.";
  const index = prBody.indexOf("#");
  return prBody.substring(index + 1);
}

async function commentOnIssueForPr(issueNumber, prUrl, baseBranch) {
  const body = `PR ${prUrl} has been merged into ${baseBranch}`;
  await octokit.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body
  });
}

async function closeTrackingIssueForPr(issueNumber) {
  await octokit.issues.update({
    owner,
    repo,
    issue_number: issueNumber,
    state: "closed"
  });
}

async function run() {
  try {
    const payload = github.context.payload;

    // const payloadFile = fs.readFileSync( 'C:\\Scratch\\github_merge_context.json');
    // console.log(payloadFile.toString());
    // const payload = JSON.parse(payloadFile.toString()).event;

    const pullRequest = payload.pull_request;

    console.log(JSON.stringify(payload, undefined, 2));

    const baseBranch = pullRequest.base.ref;
    if (!validBranches.includes(baseBranch)) {
      return;
    }

    if (baseBranch === 'master') {
      console.log(`Creating an issue for pull request ${pullRequest.number}`);
      const assignees = pullRequest.assignees.map(a => a.login);
      const body = `Tracking ${payload.owner.name}/${payload.repository.name}#${pullRequest.number}\nPR ${pullRequest.html_url} has been merged into master`;
      await createIssueForPr(pullRequest.title, assignees, body);
      return;
    }

    const issueNumber = getTrackingIssueNumberForPr(pullRequest.body);
    console.log(`Commenting on issue ${issueNumber} for pull request ${pullRequest.number}`);
    await commentOnIssueForPr(issueNumber, pullRequest.html_url, baseBranch);

    if (baseBranch === "stable") {
      console.log(`Closing issue ${issueNumber} as the final pull request has been merged to 'stable'`);
      await closeTrackingIssueForPr(issueNumber);
    }
  } catch (error) {
    core.setFailed(error.message);
  }
}

run();