import { describe, expect, it, vi } from "vitest";
import {
  resolveSubagentGraph,
  type SubagentSessionIdentity,
} from "../src/domain/subagent-graph.js";

const root = { hostId: "host-a", directory: "/repo", sessionId: "root" };

function child(
  id: string,
  parentId: string,
  overrides: Partial<SubagentSessionIdentity> = {},
): SubagentSessionIdentity {
  return {
    hostId: "host-a",
    id,
    parentId,
    directory: "/repo",
    title: id,
    ...overrides,
  };
}

function gateway(relations: Readonly<Record<string, readonly SubagentSessionIdentity[]>>) {
  return {
    listChildren: vi.fn(async (_directory: string, parentId: string) => [
      ...(relations[parentId] ?? []),
    ]),
  };
}

describe("resolveSubagentGraph", () => {
  it("discovers direct children from the bound root", async () => {
    const source = gateway({ root: [child("a", "root"), child("b", "root")] });

    const graph = await resolveSubagentGraph({ root, gateway: source });

    expect(graph.descendants.map((item) => [item.id, item.parentSessionId, item.depth])).toEqual([
      ["a", "root", 1],
      ["b", "root", 1],
    ]);
    expect(source.listChildren).toHaveBeenCalledWith("/repo", "root");
  });

  it("recursively discovers nested descendants", async () => {
    const source = gateway({ root: [child("a", "root")], a: [child("b", "a")] });

    const graph = await resolveSubagentGraph({ root, gateway: source });

    expect(graph.descendants.map((item) => [item.id, item.depth])).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  it("stops traversal at the maximum depth", async () => {
    const source = gateway({
      root: [child("a", "root")],
      a: [child("b", "a")],
      b: [child("c", "b")],
    });

    const graph = await resolveSubagentGraph({ root, gateway: source, maxDepth: 2 });

    expect(graph.descendants.map((item) => item.id)).toEqual(["a", "b"]);
    expect(graph.depthBoundaryReached).toBe(true);
    expect(source.listChildren).not.toHaveBeenCalledWith("/repo", "b");
  });

  it("stops traversal at the maximum session count", async () => {
    const source = gateway({
      root: [child("a", "root"), child("b", "root"), child("c", "root")],
    });

    const graph = await resolveSubagentGraph({ root, gateway: source, maxSessions: 2 });

    expect(graph.descendants.map((item) => item.id)).toEqual(["a", "b"]);
    expect(graph.sessionLimitReached).toBe(true);
  });

  it("is cycle-safe", async () => {
    const source = gateway({
      root: [child("a", "root")],
      a: [child("root", "a"), child("a", "a")],
    });

    const graph = await resolveSubagentGraph({ root, gateway: source });

    expect(graph.descendants.map((item) => item.id)).toEqual(["a"]);
    expect(source.listChildren).toHaveBeenCalledTimes(2);
  });

  it("excludes children from another host", async () => {
    const source = gateway({ root: [child("foreign", "root", { hostId: "host-b" })] });

    const graph = await resolveSubagentGraph({ root, gateway: source });

    expect(graph.descendants).toEqual([]);
  });

  it("excludes children from another directory", async () => {
    const source = gateway({ root: [child("foreign", "root", { directory: "/other" })] });

    const graph = await resolveSubagentGraph({ root, gateway: source });

    expect(graph.descendants).toEqual([]);
  });

  it("excludes unrelated sessions that do not name the traversed parent", async () => {
    const source = gateway({ root: [child("unrelated", "somewhere-else")] });

    const graph = await resolveSubagentGraph({ root, gateway: source });

    expect(graph.descendants).toEqual([]);
  });
});
