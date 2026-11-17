// JUnit XML output, so CI systems (GitHub Actions test reporters, GitLab,
// Jenkins) show each property, differential target or saved failure as a
// test case. Infrastructure outcomes are <error>, never <failure>: a CI
// dashboard must not show "out of gas" as a broken property.

export type JUnitOutcome = "pass" | "failure" | "error";

export type JUnitCase = {
  name: string;
  classname: string;
  outcome: JUnitOutcome;
  /** One line, for the failure or error message attribute. */
  message?: string;
  /** Failure or error type, e.g. "counterexample", "abort", "divergence", "out-of-gas". */
  type?: string;
  /** Full human-readable report for this case. */
  body: string;
};

export type JUnitSuite = {
  name: string;
  timestamp: Date;
  seconds: number;
  properties: Record<string, string>;
  cases: JUnitCase[];
};

const ANSI = /\x1b\[[0-9;]*m/g;
// Characters XML 1.0 cannot carry at all, even escaped.
const INVALID = /[^\x09\x0A\x0D\x20-퟿-�]/g;

/** Escapes text for an XML attribute or element body, dropping terminal colours and invalid characters. */
export function xmlEscape(s: string): string {
  return s.replace(ANSI, "").replace(INVALID, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export function junitXml(suite: JUnitSuite): string {
  const count = (o: JUnitOutcome) => suite.cases.filter((c) => c.outcome === o).length;
  const a = (k: string, v: string | number) => ` ${k}="${xmlEscape(String(v))}"`;
  const head = a("name", suite.name) + a("tests", suite.cases.length) + a("failures", count("failure")) +
    a("errors", count("error")) + a("skipped", 0) + a("time", suite.seconds.toFixed(3)) +
    a("timestamp", suite.timestamp.toISOString().replace(/\.\d+Z$/, ""));
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', `<testsuites${a("name", "fuzzloom")}${a("tests", suite.cases.length)}${a("failures", count("failure"))}${a("errors", count("error"))}${a("time", suite.seconds.toFixed(3))}>`, `  <testsuite${head}>`];
  lines.push("    <properties>");
  for (const [k, v] of Object.entries(suite.properties)) lines.push(`      <property${a("name", k)}${a("value", v)}/>`);
  lines.push("    </properties>");
  for (const c of suite.cases) {
    const open = `    <testcase${a("name", c.name)}${a("classname", c.classname)}`;
    if (c.outcome === "pass") {
      lines.push(`${open}>`, `      <system-out>${xmlEscape(c.body)}</system-out>`, "    </testcase>");
    } else {
      const tag = c.outcome;
      lines.push(`${open}>`, `      <${tag}${a("message", c.message ?? "")}${a("type", c.type ?? tag)}>${xmlEscape(c.body)}</${tag}>`, "    </testcase>");
    }
  }
  lines.push("  </testsuite>", "</testsuites>", "");
  return lines.join("\n");
}
