export const groupLabel = group => String(group.remark || group.name || `群 ${group.id.slice(0, 8)}`)
  .replace(/[\x00-\x1f\x7f\\`*_#<>\[\]()~]/g, ' ').trim().slice(0, 60);
