let idSeq = Math.floor(Math.random() * 46656);

export const nid = (prefix = 'j') => {
  idSeq = (idSeq + 1) % 46656;
  return prefix + Date.now().toString(36).slice(-5) + idSeq.toString(36).padStart(3, '0');
};

export const preview = (value, length = 48) => {
  const line = String(value ?? '').split('\n')[0];
  return line.length > length ? line.slice(0, length - 1) + '…' : line;
};
