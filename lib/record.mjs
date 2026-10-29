// A record is also a component. Message metadata belongs to the record;
// content components have no message timestamp or speaker of their own.
export function assertRecord(record) {
  if (!record || record.type !== 'record' || !Array.isArray(record.components)) throw new Error('MESSAGE_RECORD_FORMAT_UNSUPPORTED');
  return record;
}

// Model projections may be a readable record or an opaque, body-free reference.
export function assertRecordContent(value) {
  if (value?.type === 'record_ref' && typeof value.messageId === 'string' && value.messageId && !('components' in value)) return value;
  return assertRecord(value);
}

// Traversal follows only materialized components. It performs no I/O or implicit
// expansion; record_ref is always a leaf, never a body to traverse.
export function* recordComponents(record) {
  if (record?.type === 'record_ref') return;
  for (const component of record ? assertRecord(record).components : []) {
    yield component;
    if (component.type === 'record') yield* recordComponents(component);
  }
}
export function recordReferences(record) {
  const references = new Set();
  const visit = value => {
    if (!value || value.type === 'record_ref') return;
    for (const component of assertRecord(value).components) {
      if (['record_ref', 'record'].includes(component.type) && component.messageId) {
        references.add(component.messageId);
        // A direct message boundary ends this page, even for a materialized
        // stored child. Its own references belong to a separate explicit read.
      } else if (component.type === 'record') visit(component);
    }
  };
  visit(record);
  return [...references];
}
