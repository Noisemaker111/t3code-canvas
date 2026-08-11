const GITHUB_PULL_REQUEST_URL_PATTERN =
  /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)(?:[/?#].*)?$/i;
const GITLAB_MERGE_REQUEST_URL_PATTERN =
  /^https:\/\/[^/\s]*gitlab[^/\s]*\/.+\/-\/merge_requests\/(\d+)(?:[/?#].*)?$/i;
const AZURE_DEVOPS_PULL_REQUEST_URL_PATTERN =
  /^https:\/\/(?:dev\.azure\.com\/[^/\s]+\/[^/\s]+|[^/\s]+\.visualstudio\.com\/[^/\s]+)\/_git\/[^/\s]+\/pullrequest\/(\d+)(?:[/?#].*)?$/i;
const PULL_REQUEST_NUMBER_PATTERN = /^#?(\d+)$/;
const GITHUB_CLI_PR_CHECKOUT_PATTERN = /^gh\s+pr\s+checkout\s+(.+)$/i;
const GITLAB_CLI_MR_CHECKOUT_PATTERN = /^glab\s+mr\s+checkout\s+(.+)$/i;
const AZURE_DEVOPS_CLI_PR_CHECKOUT_PATTERN = /^az\s+repos\s+pr\s+checkout\s+(.+)$/i;

function parseAzureDevOpsCheckoutReference(args: string): string | null {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  for (const [index, part] of parts.entries()) {
    if (part === "--id" || part === "-i") {
      return parts[index + 1] ?? null;
    }
    if (part.startsWith("--id=")) {
      return part.slice("--id=".length) || null;
    }
  }
  return parts.find((part) => !part.startsWith("-")) ?? null;
}

/**
 * The `#1450` on a card face, for cards stored before the board recorded the
 * number. Null when the URL is not a pull/merge request the board recognises.
 */
export function parsePullRequestNumber(url: string | null | undefined): number | null {
  if (!url) return null;
  const trimmed = url.trim();
  const match =
    GITHUB_PULL_REQUEST_URL_PATTERN.exec(trimmed) ??
    GITLAB_MERGE_REQUEST_URL_PATTERN.exec(trimmed) ??
    AZURE_DEVOPS_PULL_REQUEST_URL_PATTERN.exec(trimmed);
  if (!match?.[1]) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parsePullRequestReference(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const ghCliCheckoutMatch = GITHUB_CLI_PR_CHECKOUT_PATTERN.exec(trimmed);
  const glabCliCheckoutMatch = GITLAB_CLI_MR_CHECKOUT_PATTERN.exec(trimmed);
  const azureDevOpsCliCheckoutMatch = AZURE_DEVOPS_CLI_PR_CHECKOUT_PATTERN.exec(trimmed);
  const normalizedInput =
    ghCliCheckoutMatch?.[1]?.trim() ??
    glabCliCheckoutMatch?.[1]?.trim() ??
    (azureDevOpsCliCheckoutMatch?.[1]
      ? parseAzureDevOpsCheckoutReference(azureDevOpsCliCheckoutMatch[1])
      : null) ??
    trimmed;
  if (normalizedInput.length === 0) {
    return null;
  }

  const urlMatch =
    GITHUB_PULL_REQUEST_URL_PATTERN.exec(normalizedInput) ??
    GITLAB_MERGE_REQUEST_URL_PATTERN.exec(normalizedInput) ??
    AZURE_DEVOPS_PULL_REQUEST_URL_PATTERN.exec(normalizedInput);
  if (urlMatch?.[1]) {
    return normalizedInput;
  }

  const numberMatch = PULL_REQUEST_NUMBER_PATTERN.exec(normalizedInput);
  if (numberMatch?.[1]) {
    return numberMatch[1];
  }

  return null;
}
