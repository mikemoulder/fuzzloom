// Exhaustive checks against a BigInt reference. Fe compares each result
// directly to the expected byte, so there is no fingerprint collision.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { defaultFeConfig, feVersion, nativeFeVersion, runBatch } from "../packages/cli/src/fe.ts";
import { libraryIngot } from "../packages/cli/src/harness.ts";
import { toJson } from "../packages/cli/src/report.ts";

// Convert the input byte to a mathematical integer. Signed right shifts
// divide by a power of two and round toward negative infinity. Left shifts
// multiply and keep the low byte. JavaScript bitwise shifts are not used.
function model(byte, count, signed, left) {
  const x = BigInt(signed && byte >= 128 ? byte - 256 : byte);
  const scale = 2n ** BigInt(count);
  const result = left ? x * scale : (x < 0n ? x - scale + 1n : x) / scale;
  return Number(((result % 256n) + 256n) % 256n);
}

function table(signed, left, corrupt) {
  const words = [];
  for (let count = 0; count <= 8; count++) {
    for (let first = 0; first < 256; first += 32) {
      let word = 0n;
      for (let i = 0; i < 32; i++) {
        const value = corrupt && count === 0 && first + i === 0 ? 1 : model(first + i, count, signed, left);
        word += BigInt(value) * (256n ** BigInt(i));
      }
      words.push(`0x${word.toString(16)}`);
    }
  }
  return words.join(", ");
}

function source({ name, signed, left, corrupt }) {
  const type = signed ? "i8" : "u8";
  const limit = signed ? 128 : 256;
  return `
#[test]
fn ${name}() {
    let expected: [u256; 72] = [${table(signed, left, corrupt)}]
    var count: u64 = 0
    while count < ${limit} {
        let rhs: ${type} = count.downcast_unchecked()
        let row = if count > 8 { 8 } else { count }
        var byte: u64 = 0
        while byte < 256 {
            let lhs: ${type} = byte.downcast_unchecked()
            let actual: u8 = (lhs ${left ? "<<" : ">>"} rhs).downcast_unchecked()
            let idx: usize = (row * 8 + byte / 32).downcast_truncate()
            let shift = ((byte % 32) * 8) as u256
            let want: u8 = (expected[idx] >> shift).downcast_truncate()
            if actual != want {
                revert_error(Evaluated {
                    arity: 3, input0: byte as u256, input1: count as u256,
                    input2: want as u256, output: actual as u256,
                })
            }
            byte += 1
        }
        count += 1
    }
    revert_error(Evaluated { arity: 1, input0: ${limit * 256}, input1: 0, input2: 0, output: 0 })
}
`;
}

const cases = [false, true].flatMap((signed) => [false, true].map((left) => ({
  name: `oracle_${signed ? "i8" : "u8"}_${left ? "shl" : "shr"}`, signed, left, corrupt: false,
})));
cases.push({ name: "oracle_negative_control", signed: false, left: false, corrupt: true });
const root = mkdtempSync(join(tmpdir(), "fuzzloom-shift-reference-"));
const fe = defaultFeConfig();
try {
  mkdirSync(join(root, "src"));
  const dependency = relative(root, libraryIngot()).split("\\").join("/");
  writeFileSync(join(root, "fe.toml"), `[ingot]\nname = "shift_reference"\nversion = "0.1.0"\n[dependencies]\nfuzzloom = { path = "${dependency}" }\n`);
  writeFileSync(join(root, "src/lib.fe"), "use fuzzloom::Evaluated\nuse std::evm::revert_error\n" + cases.map(source).join(""));
  const backends = ["sonatina", "native"];
  const outcomes = await Promise.all(backends.map((backend) => runBatch(root, cases.map((c) => c.name), backend, fe)));
  const report = outcomes.map(({ outcomes: results }, i) => ({
    backend: backends[i],
    fe: i === 0 ? feVersion(fe) : nativeFeVersion(fe),
    results: results.map((result, j) => ({ name: cases[j].name, result })),
  }));
  console.log(JSON.stringify(toJson(report), null, 2));
  for (const { backend, results } of report) {
    for (const [i, { name, result }] of results.entries()) {
      const where = `${backend}: ${name}`;
      assert.equal(result.kind, "evaluated", where);
      if (cases[i].corrupt) {
        assert.deepEqual(result, { kind: "evaluated", arity: 3, input: [0n, 0n, 1n], output: 0n }, where);
      } else {
        assert.deepEqual(result, {
          kind: "evaluated", arity: 1, input: [cases[i].signed ? 32768n : 65536n, 0n, 0n], output: 0n,
        }, where);
      }
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
