### Maintenance
- Native TypeScript checks use less CPU with `GOGC=400`, trading some RAM for fewer collections
  while retaining GC for concurrent CI runners. Caller `GOGC` and `GOMEMLIMIT` settings are preserved.
