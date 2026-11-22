import { describe, expect, it } from "vitest";
import { appendInputHistory, inputHistoryLimit, readInputHistory, writeInputHistory } from "../../src/app/ui/inputHistory.ts";

function fakeStorage(seed = ""): Storage {
  let value = seed;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
    removeItem: () => { value = ""; },
    clear: () => { value = ""; },
    key: () => null,
    length: 0,
  } as Storage;
}

describe("composer input history", () => {
  it("keeps the newest message first, deduplicates and ignores blank input", () => {
    const first = appendInputHistory([], "  hello  ");
    expect(first).toEqual(["hello"]);
    const second = appendInputHistory(first, "second");
    expect(second).toEqual(["second", "hello"]);
    expect(appendInputHistory(second, "second")).toEqual(["second", "hello"]);
    expect(appendInputHistory(second, "   ")).toEqual(second);
  });

  it("caps the stored history", () => {
    const history = Array.from({ length: inputHistoryLimit + 20 }, (_, index) => `msg-${index}`);
    expect(history).toHaveLength(inputHistoryLimit + 20);
    const result = appendInputHistory(history, "newest");
    expect(result).toHaveLength(inputHistoryLimit);
    expect(result[0]).toBe("newest");
  });

  it("reads only string entries and tolerates corrupt data", () => {
    expect(readInputHistory(fakeStorage('["a",1,null,"b"]'), "key")).toEqual(["a", "b"]);
    expect(readInputHistory(fakeStorage("not json"), "key")).toEqual([]);
    expect(readInputHistory(fakeStorage('{"a":1}'), "key")).toEqual([]);
  });

  it("persists through writeInputHistory and ignores storage failures", () => {
    const storage = fakeStorage();
    writeInputHistory(storage, "key", ["one", "two"]);
    expect(readInputHistory(storage, "key")).toEqual(["one", "two"]);
    const broken = { getItem: () => "", setItem: () => { throw new Error("denied"); } } as unknown as Storage;
    expect(() => writeInputHistory(broken, "key", ["x"])).not.toThrow();
  });
});
