type FileEntry = { path: string; status: string };
const STATUS: Record<string, string> = { tracked: "文件", added: "新增", add: "新增", ADD: "新增", deleted: "删除", delete: "删除", DELETE: "删除", removed: "删除", modified: "修改", modify: "修改", MODIFY: "修改", renamed: "重命名", rename: "重命名", MOVE: "重命名", copied: "复制", copy: "复制", COPY: "复制" };

export function ReviewFileDirectory({ files, prefix = "", selected, counts, onSelect, countLabel = "个问题" }: { files: FileEntry[]; prefix?: string; selected: string; counts: Map<string, number>; countLabel?: "个问题" | "条意见"; onSelect(path: string): void }) {
  const directories = new Map<string, FileEntry[]>();
  const leaves: FileEntry[] = [];
  for (const file of files) {
    const remainder = file.path.slice(prefix.length);
    const slash = remainder.indexOf("/");
    if (slash < 0) leaves.push(file);
    else {
      const name = remainder.slice(0, slash);
      const group = directories.get(name) ?? [];
      group.push(file); directories.set(name, group);
    }
  }
  return <ul>{[...directories].sort(([a], [b]) => a.localeCompare(b)).map(([name, children]) => <li key={`${prefix}${name}/`}><details open><summary aria-label={`${name}，${children.length} 个文件`}>{name}<small>{children.length}</small></summary><ReviewFileDirectory files={children} prefix={`${prefix}${name}/`} selected={selected} counts={counts} countLabel={countLabel} onSelect={onSelect} /></details></li>)}
    {leaves.sort((a, b) => a.path.localeCompare(b.path)).map(file => { const count = counts.get(file.path) ?? 0; return <li key={file.path}><button title={file.path} aria-label={count ? `${file.path}（${count} ${countLabel}）` : file.path} aria-current={file.path === selected ? "true" : undefined} onClick={() => onSelect(file.path)}><span>{file.path.slice(prefix.length)}</span>{count ? <em className="pr-diff-file-findings">{count} {countLabel}</em> : null}<small>{STATUS[file.status] ?? file.status}</small></button></li>; })}</ul>;
}

