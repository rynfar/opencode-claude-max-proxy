import { describe, expect, it } from "bun:test";
import { LRUMap } from "../src/utils/lru-map";

describe("LRUMap", () => {
  it("stores and retrieves values", () => {
    const map = new LRUMap<string, number>(3);
    map.set("a", 1);
    map.set("b", 2);
    expect(map.get("a")).toBe(1);
    expect(map.get("b")).toBe(2);
    expect(map.get("c")).toBeUndefined();
    expect(map.size).toBe(2);
  });

  it("evicts the oldest entry when maxSize is exceeded", () => {
    const map = new LRUMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3); // evicts "a"

    expect(map.get("a")).toBeUndefined();
    expect(map.get("b")).toBe(2);
    expect(map.get("c")).toBe(3);
    expect(map.size).toBe(2);
  });

  it("refreshes recency on get()", () => {
    const map = new LRUMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.get("a"); // refreshes "a", "b" is now oldest
    map.set("c", 3); // evicts "b"

    expect(map.get("a")).toBe(1);
    expect(map.get("b")).toBeUndefined();
    expect(map.get("c")).toBe(3);
  });

  it("refreshes recency on set() update", () => {
    const map = new LRUMap<string, number>(2);
    map.set("a", 1);
    map.set("b", 2);
    map.set("a", 10); // update refreshes "a"
    map.set("c", 3); // evicts "b"

    expect(map.get("a")).toBe(10);
    expect(map.get("b")).toBeUndefined();
    expect(map.get("c")).toBe(3);
  });

  it("fires onEvict callback with evicted key and value", () => {
    const evicted: [string, number][] = [];
    const map = new LRUMap<string, number>(2, (k, v) => evicted.push([k, v]));

    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3);

    expect(evicted).toEqual([["a", 1]]);
  });

  it("does NOT fire onEvict on manual delete()", () => {
    const evicted: string[] = [];
    const map = new LRUMap<string, number>(3, (k) => evicted.push(k));

    map.set("a", 1);
    map.delete("a");

    expect(evicted).toEqual([]);
    expect(map.has("a")).toBe(false);
  });

  it("does NOT fire onEvict on clear()", () => {
    const evicted: string[] = [];
    const map = new LRUMap<string, number>(3, (k) => evicted.push(k));

    map.set("a", 1);
    map.set("b", 2);
    map.clear();

    expect(evicted).toEqual([]);
    expect(map.size).toBe(0);
  });

  it("supports has(), delete(), and iteration", () => {
    const map = new LRUMap<string, number>(5);
    map.set("x", 10);
    map.set("y", 20);

    expect(map.has("x")).toBe(true);
    expect(map.has("z")).toBe(false);

    map.delete("x");
    expect(map.has("x")).toBe(false);
    expect(map.size).toBe(1);

    const entries: [string, number][] = [];
    for (const [k, v] of map) {
      entries.push([k, v]);
    }
    expect(entries).toEqual([["y", 20]]);
  });

  it("supports forEach()", () => {
    const map = new LRUMap<string, number>(5);
    map.set("a", 1);
    map.set("b", 2);

    const collected: [string, number][] = [];
    map.forEach((v, k) => {
      collected.push([k, v]);
    });
    expect(collected).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("handles maxSize of 1", () => {
    const map = new LRUMap<string, number>(1);
    map.set("a", 1);
    map.set("b", 2);

    expect(map.get("a")).toBeUndefined();
    expect(map.get("b")).toBe(2);
    expect(map.size).toBe(1);
  });

  it("chains multiple evictions correctly", () => {
    const evicted: string[] = [];
    const map = new LRUMap<string, number>(2, (k) => evicted.push(k));

    map.set("a", 1);
    map.set("b", 2);
    map.set("c", 3); // evicts a
    map.set("d", 4); // evicts b

    expect(evicted).toEqual(["a", "b"]);
    expect(map.size).toBe(2);
    expect(map.get("c")).toBe(3);
    expect(map.get("d")).toBe(4);
  });
});
