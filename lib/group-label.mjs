export const groupLabel = group => String(group.remark || group.name || '未命名群')
  .replace(/[\x00-\x1f\x7f\\`*_#<>\[\]()~]/g, ' ').trim().slice(0, 60);
