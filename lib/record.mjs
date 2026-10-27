// A record is also a component. Message metadata belongs to the record;
// content components have no message timestamp or speaker of their own.
export function assertRecord(record) {
  if (!record || record.type !== 'record' || !Array.isArray(record.components)) throw new Error('MESSAGE_RECORD_FORMAT_UNSUPPORTED');
  return record;
}

// Traversal follows only materialized components. It performs no I/O or implicit
// expansion; references with empty components remain explicit references.
export function* recordComponents(record) {
  for (const component of record ? assertRecord(record).components : []) {
    yield component;
    if (component.type === 'record') yield* recordComponents(component);
  }
}
export function recordReferences(record) {
  return [...new Set([...recordComponents(record)].filter(item => item.type === 'record' && item.messageId)
    .map(item => item.messageId))];
}
