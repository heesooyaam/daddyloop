// Executed from the trusted workflow revision. PR metadata is API data only.
module.exports = async function linkPrIssue(github, { owner, repo }, number) {
  const ref = { owner, repo };
  const query = `query($owner:String!, $repo:String!, $number:Int!) {
    viewer { login }
    repository(owner:$owner, name:$repo) {
      pullRequest(number:$number) { title body state closingIssuesReferences(first:1) { totalCount } }
    }
  }`;
  const read = () => github.graphql(query, { ...ref, number });
  const { repository, viewer } = await read();
  const pr = repository.pullRequest;
  const needsLink = (value) => value.state === 'OPEN' && !value.closingIssuesReferences.totalCount;

  // An explicit source can precede GitHub's link indexing or target a feature branch.
  async function sourceIssue(body) {
    const match = (body || '').match(
      /^\s*(Closes?|Closed|Fix(?:es|ed)?|Resolve[sd]?|Source|Issue|Тикет GitHub)\s*[:—-]?\s+(?:#(\d+)|https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+))\s*$/im,
    );
    if (!match) return;
    const issue = {
      owner: match[3] || owner,
      repo: match[4] || repo,
      issue_number: Number(match[2] || match[5]),
    };
    try {
      const { data } = await github.rest.issues.get(issue);
      if (!data.pull_request)
        return {
          linked: !/^(source|issue|тикет github)$/i.test(match[1]),
          reference:
            issue.owner.toLowerCase() === owner.toLowerCase() &&
            issue.repo.toLowerCase() === repo.toLowerCase()
              ? '#' + data.number
              : issue.owner + '/' + issue.repo + '#' + data.number,
        };
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  if (!needsLink(pr)) return;
  const source = await sourceIssue(pr.body);
  if (source?.linked) return;
  const marker = `<!-- daddyloop:pr-issue:${number} -->`;
  let issueNumber;
  if (!source) {
    for await (const page of github.paginate.iterator(github.rest.issues.listForRepo, {
      ...ref,
      creator: viewer.login,
      state: 'all',
      per_page: 100,
    })) {
      const previous = page.data.find(
        (issue) => !issue.pull_request && issue.body?.split('\n').includes(marker),
      );
      if (previous) {
        issueNumber = previous.number;
        break;
      }
    }
    if (!issueNumber) {
      const { data } = await github.rest.issues.create({
        ...ref,
        title: pr.title,
        body: `изменение и ход работы — в PR #${number}\n\n${marker}`,
      });
      issueNumber = data.number;
    }
  }

  // Keep edits made while the issue was being located or created.
  const latest = (await read()).repository.pullRequest;
  if (!needsLink(latest)) return;
  const latestSource = latest.body === pr.body ? source : await sourceIssue(latest.body);
  if (!latestSource?.linked)
    await github.rest.pulls.update({
      ...ref,
      pull_number: number,
      body: [
        latest.body,
        `Closes ${latestSource?.reference || source?.reference || '#' + issueNumber}`,
      ]
        .filter(Boolean)
        .join('\n\n'),
    });
};
