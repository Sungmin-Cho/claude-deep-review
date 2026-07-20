# Research Note: cache eviction strategies

## Question

Which eviction policy minimizes recomputation for our access pattern?

## Findings

- LRU outperforms FIFO on our traces.
- Segmented LRU adds little for the extra complexity.

## Observations

Access exhibits strong temporal locality.

## References

- Internal latency traces from the last quarter.

## Open questions

Does the pattern hold under a seasonal traffic shift?
