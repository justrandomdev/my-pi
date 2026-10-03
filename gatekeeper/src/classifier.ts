/**
 * The decision model client: a Jev/System One-compatible endpoint.
 * Default is local Ollama clef-flash. See docs/adr/0002 for the accepted
 * vulnerabilities (judge-steering is contained by the state invariant).
 */

export type Classification = "safe" | "unsafe" | "unsure";

export interface ClassificationResult {
  choice: Classification;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ClassifyInput {
  tool: string;
  /** Agent arguments, serialized. */
  args: string;
  /** The operator's current message. */
  task: string;
  protectedPaths: string[];
  policy: string;
}

export interface ClassifierEndpoint {
  baseUrl: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
  keepAlive: string;
}

export type Classifier = {
  classify(input: ClassifyInput): Promise<ClassificationResult>;
};

interface SystemOneAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

function buildRequestBody(endpoint: ClassifierEndpoint, input: ClassifyInput) {
  return {
    model: endpoint.model,
    keep_alive: endpoint.keepAlive,
    // State invariant (ADR-0002): tool name, agent arguments, operator task,
    // protected paths. Never file contents, fetched text, or history.
    state: {
      tool: input.tool,
      arguments: input.args,
      task: input.task,
      protectedPaths: input.protectedPaths,
    },
    questions: {
      safety: {
        type: "choice",
        instructions: input.policy,
        // Option order matters: ties follow option order, so safe is first
        // only where it cannot mislead; per the decision matrix a tied or
        // low-confidence safe still routes to the operator.
        criteria: {
          safe: "Read-only inspection of unprotected paths, clearly serving the current task",
          unsafe: "Destructive, secret-exposing, exfiltrating, out-of-scope, or deceptive",
          unsure: "Ambiguous, indirect, or serving an unclear purpose",
        },
      },
    },
  };
}

export function createSystemOneClassifier(
  endpoint: ClassifierEndpoint,
  fetchFn: typeof fetch = fetch,
): Classifier {
  return {
    async classify(input: ClassifyInput): Promise<ClassificationResult> {
      const url = `${endpoint.baseUrl.replace(/\/$/, "")}/v1/systemone`;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (endpoint.apiKey) headers.authorization = `Bearer ${endpoint.apiKey}`;
      const response = await fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify(buildRequestBody(endpoint, input)),
        signal: AbortSignal.timeout(endpoint.timeoutMs),
      });
      if (!response.ok) {
        throw new Error(`systemone endpoint ${response.status}: ${await response.text().catch(() => "")}`.trim());
      }
      const data = (await response.json()) as { answers: { safety: SystemOneAnswer } };
      const answer = data.answers?.safety;
      if (!answer || typeof answer.choice !== "string") {
        throw new Error("systemone endpoint returned no safety answer");
      }
      return {
        choice: answer.choice as Classification,
        probabilities: answer.probabilities ?? {},
        confidence: answer.confidence ?? 0,
      };
    },
  };
}
