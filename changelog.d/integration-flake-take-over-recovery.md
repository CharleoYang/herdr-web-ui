### Maintenance
- The take-over integration test for an ordinary failed attach now holds its first bytes long
  enough that a busy runner never takes the failing attempt's last line for an attach before its
  exit arrives.
