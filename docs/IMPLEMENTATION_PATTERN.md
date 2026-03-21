# Implementation Pattern

This document captures the implementation pattern to follow in this repository.

It is methodological. It is not a substitute for module contracts in `.mli` files.

## The approach

1. You turn the problem into a set of types. You just write out the types of the problem.
2. You write a set of simple state machines, or a few simple state machines. Literally just the state machine, nothing else. Just the state machine transitions.
3. The rest of the code is somewhat incidental. You write it out as well, but you write it either as a literate file or in OCaml.
4. You can write out the MLI signatures. All docstrings are perfectly acceptable. The main wiki just has the state machine, and then the other stuff is the actual components.
5. You can have docstrings; you either use docstrings or a literate file. The two are very similar in some ways.
6. In OCaml you can do lots of boundaries very easily.
7. Testing: you can prove things about the state machine, which is cool, but it should be simple enough to simply inspect.
8. The stuff within the state, once it’s in a state machine, you then just do a bunch of invariant testing. Stuff also has explicit invariants. You have a docstring which describes the invariants, and then a lot of invariants you can put into types, which is quite nice, but there’s still some you can’t.
9. It’s very very mild design by contract. Not provable design by contract, just approaching things a little bit as a contract.
10. I don’t need to split everything up into separate components. It’s just a state machine.
11. Target is very very concise code.
12. OCaml primarily. TypeScript works pretty much similarly.

## State machines

- State machines as ADTs. Sum types with pattern matching. Not typestate, not phantom types.
- Even for expensive computation or recursive algorithms — a state machine of computing, not computing, failed, etc. for graceful crashes.
- The state machines for those might be very very simple, but you’d absolutely still want some amount of state machine for crash handling.
- State machines live in their own file or files.
- State machine files should just be state machine.

## I never said pure

- I didn’t say everything is pure. Don’t project that.

## Types are the contracts

- Typed contracts.
- Can do invariants over multiple functions.
- Happy to do test `f` where `f` is `g(h(x))`.
- Can initialise from state machine states.
- But invariants are local.
- The actual tests/checks/property tests are local.

## Two regimes of code

- Anything DBC (design by contract) — don’t care about complexity, can be as complicated as it wants.
- Anything not DBC (e.g. ports, state machine) — must be clear. Must be simple enough to verify by reading.
- If uncontracted code is getting complicated, either add contracts or simplify.

## File structure

- Three files: `.mli` file (docstrings and contract for a whole module), `.ml` file (concise), maybe a test file or inline properties.
- State machines in their own file(s).
- The functional modules can be complicated, that’s fine. But state machine files should just be state machine.

## Documentation

- All docs are docstrings except a few high-level ones i.e. README.
- Intents (implementation-agnostic) can sit on top too.

## Testing

Two kinds of tests: livedrives and unit tests with invariant/property testing.

### Livedrives

- Livedrives are nothing except it works in use. Literal driving.
- Of varying possibility.
- Maybe also simulations. These might work at ports and run through scenarios but are a bunch of property generators.
- Explicitly golden paths.
- Livedrives are NOT integration tests. I don’t believe in integration tests whatsoever.
- Livedrives are anti-hallucination by LLM.

### Programmatic tests

- State machines must be testable pretty isolated.
- Can run through states.
- Generally: pure functions OR in state machine OR external bound.
- External => generator, type inferred or not.
- Pure functions => DBC + property testing.
- State/behavioural => explicit state machine.
- Initialise states and run property tests too. Random start, random stops for reliability checking.
- “From state X do Y” — all programmatic.
- Basically nothing that could become outdated on change.

### What’s not there

- No integration tests.
- Nothing global. Invariants are local.
- Nothing that could go stale silently.

## Code readability

- Code readability and clarity is vital.
- Concise enough to read directly. If not, probably librarised.

## AI optimality

- The target is patterns that are AI-optimal.
- Livedrives are specifically anti-hallucination for LLM-generated code.
