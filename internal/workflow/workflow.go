// Package workflow defines the state machines for epics and stories.
//
// PROVISIONAL: the detailed transition rules have not been specified yet.
// The tables below allow moving forward one step along the listed order and
// cancelling from any non-terminal state. Replace the tables (and add guards)
// once the real rules are supplied; nothing else should need to change.
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
var Story = newLinear([]string{"draft", "review", "design", "implementation", "testing", "finished"})
