/**
 * @copyright Teffen Ellis
 * @license AGPL-3.0
 * @author Teffen Ellis, et al.
 */

import test from "tape"
import { Graph } from "./Graph.js"

class ExampleNode {}

test("constructor", (t) => {
	const graph = new Graph<ExampleNode>()
	t.deepEquals(graph.edges, {})
	t.end()
})

test("add", (t) => {
	const graph = new Graph<ExampleNode>()
	t.deepEquals(graph.edges, {})

	const node = new ExampleNode()

	const ok1 = graph.add("foo", node)
	t.equal(graph.edges.foo!.length, 1, "Node added")
	t.true(ok1, "Relationship added")

	const ok2 = graph.add("foo", node)
	t.equal(graph.edges.foo!.length, 1, "Node not added")
	t.false(ok2, "Node already exists")

	const ok3 = graph.add("bar", node)
	t.equal(graph.edges.bar!.length, 1, "Node added")
	t.true(ok3, "Relationship added")

	t.end()
})

test("remove", (t) => {
	const graph = new Graph<ExampleNode>()
	const node1 = new ExampleNode()
	const node2 = new ExampleNode()

	graph.add("foo", node1)
	graph.add("bar", node1)
	graph.add("foo", node2)

	const ok1 = graph.remove("foo", node1)
	t.equal(graph.edges.foo!.length, 1, "Node not removed")
	t.true(ok1, "Relationship removed")

	const ok2 = graph.remove("foo", node1)
	t.equal(graph.edges.foo!.length, 1, "Node not removed")
	t.false(ok2, "No relationship to remove")

	const ok3 = graph.remove("bar", node1)
	t.false(graph.edges.bar, "No relationship to remove")
	t.true(ok3, "Relationship removed")

	const ok4 = graph.remove("baz", node1)
	t.false(graph.edges.baz, "No relationship to remove")
	t.false(ok4, "No relationship to remove")

	t.end()
})

test("length", (t) => {
	const graph = new Graph<ExampleNode>()
	const node1 = new ExampleNode()
	const node2 = new ExampleNode()

	graph.add("foo", node1)
	graph.add("bar", node1)
	graph.add("foo", node2)

	const foo = graph.length("foo")
	t.equals(foo, 2, "Found two nodes with 'foo' relationship")

	const bar = graph.length("bar")
	t.equals(bar, 1, "Found one node with 'bar' relationship")

	const baz = graph.length("baz")
	t.equals(baz, 0, "Found zero nodes with 'baz' relationship")

	t.end()
})

test("findAll", (t) => {
	const graph = new Graph<ExampleNode>()
	const node1 = new ExampleNode()
	const node2 = new ExampleNode()

	graph.add("foo", node1)
	graph.add("bar", node1)
	graph.add("foo", node2)

	const foo = graph.findAll("foo")
	t.deepEquals(foo, [node1, node2])

	const bar = graph.findAll("bar")
	t.deepEquals(bar, [node1])

	const baz = graph.findAll("baz")
	t.deepEquals(baz, [])

	t.end()
})

test("findOne", (t) => {
	const graph = new Graph<ExampleNode>()
	const node1 = new ExampleNode()
	const node2 = new ExampleNode()

	graph.add("foo", node1)
	graph.add("bar", node1)
	graph.add("foo", node2)

	const foo = graph.findOne("foo")
	t.equals(foo, node1, "Found first node with 'foo' relationship")

	const bar = graph.findOne("bar")
	t.equals(bar, node1, "Found first node with 'bar' relationship")

	const baz = graph.findOne("baz")
	t.equals(baz, null, "Did not find any nodes with 'baz' relationship")

	t.end()
})

class TestNode {
	constructor(public name: string) {}
}

test("some", (t) => {
	const graph = new Graph<TestNode>()

	const node1 = new TestNode("A")
	const node2 = new TestNode("B")

	graph.add("foo", node1)
	graph.add("bar", node1)
	graph.add("foo", node2)

	const foo = graph.some("foo", (n) => n.name === "A")
	t.true(foo, "Found some nodes with 'foo' relationship")

	const bar = graph.some("bar", (n) => n.name === "B")
	t.false(bar, "Did not find some nodes with 'bar' relationship")

	const baz = graph.some("baz", (n) => n.name === "A")
	t.false(baz, "Did not find some nodes with 'baz' relationship")

	const nofunc = graph.some("baz")
	t.false(nofunc, "No function provided yields false")

	t.end()
})

test("every", (t) => {
	const graph = new Graph<TestNode>()

	const node1 = new TestNode("A")
	const node2 = new TestNode("B")

	graph.add("foo", node1)
	graph.add("bar", node1)
	graph.add("foo", node2)

	const foo = graph.every("foo", (n) => n.name === "A")
	t.false(foo, "Did not find every nodes with 'foo' relationship")

	const bar = graph.every("bar", (n) => n.name === "A")
	t.true(bar, "Found every nodes with 'bar' relationship")

	const baz = graph.every("baz", (n) => n.name === "A")
	t.false(baz, "Did not find every nodes with 'baz' relationship")

	const nofunc = graph.every("baz")
	t.false(nofunc, "No function provided yields false")

	t.end()
})
