// Package workflow defines the state machines for epics and stories.
//
// Epic: the transition table is final. An epic moves one step forward
// (draft -> review -> ready -> finished) and may be cancelled from draft,
// review or ready; finished and cancelled are final. The rules that need data
// (finishing requires finished/cancelled stories, cancelling cascades to
// stories) live in package service.
//
// Story: the transition table is final. A story moves forward
// (draft -> review -> design -> implementation -> testing -> finished), may
// step back from implementation to design and from testing to implementation
// or design, and may be cancelled from any state except finished; finished
// and cancelled are final. The rules that need data (the epic's state gates
// review/design, finishing requires finished dependencies) live in package
// service.
package workflow

import (
	"errors"
	"fmt"
)

var (
	// ErrIllegalTransition is returned when a transition is not allowed.
	ErrIllegalTransition = errors.New("illegal transition")
	// ErrUnknownState is returned for a state name the machine does not define.
	ErrUnknownState = errors.New("unknown state")
)

// Machine is a table-driven state machine.
type Machine struct {
	Initial     string
	States      []string
	transitions map[string][]string
}

// Check returns nil if moving from -> to is allowed.
func (m *Machine) Check(from, to string) error {
	if !m.Valid(to) {
		return fmt.Errorf("%w: %q", ErrUnknownState, to)
	}
	for _, t := range m.transitions[from] {
		if t == to {
			return nil
		}
	}
	return fmt.Errorf("%w: %s -> %s", ErrIllegalTransition, from, to)
}

// Valid reports whether s is a state of this machine.
func (m *Machine) Valid(s string) bool {
	for _, x := range m.States {
		if x == s {
			return true
		}
	}
	return false
}

// Targets lists the states reachable from the given state.
func (m *Machine) Targets(from string) []string {
	out := make([]string, len(m.transitions[from]))
	copy(out, m.transitions[from])
	return out
}

// newLinear builds a machine that moves forward one step at a time along
// order, may cancel from any state before the last step, and treats the final
// state and "cancelled" as terminal.
func newLinear(order []string) *Machine {
	// order's last element is the terminal "finished" state.
	states := append(append([]string{}, order...), "cancelled")
	tr := map[string][]string{}
	for i, s := range order[:len(order)-1] {
		tr[s] = []string{order[i+1], "cancelled"}
	}
	return &Machine{Initial: order[0], States: states, transitions: tr}
}

// Epic is the epic state machine.
var Epic = newLinear([]string{"draft", "review", "ready", "finished"})

// Story is the story state machine.
var Story = &Machine{
	Initial: "draft",
	States:  []string{"draft", "review", "design", "implementation", "testing", "finished", "cancelled"},
	transitions: map[string][]string{
		"draft":          {"review", "cancelled"},
		"review":         {"design", "cancelled"},
		"design":         {"implementation", "cancelled"},
		"implementation": {"testing", "design", "cancelled"},
		"testing":        {"finished", "implementation", "design", "cancelled"},
	},
}
