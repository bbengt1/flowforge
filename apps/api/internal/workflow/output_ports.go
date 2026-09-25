package workflow

// OutputPortNames returns the declared output port names for a catalog
// node type. An unknown type returns nil so a success cannot invent ports.
func OutputPortNames(nodeType string) []string {
	node, ok := lookupNode(nodeType)
	if !ok {
		return nil
	}
	names := make([]string, 0, len(node.Outputs))
	for _, port := range node.Outputs {
		names = append(names, port.Name)
	}
	return names
}
