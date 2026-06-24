// 路径展示工具：把长 vault 路径压成 ".../父目录/文件名"，用于卡片/选择器的
// 来源标注。纯函数、零依赖（从 view.ts 提出，供 view 与 parent-picker 共用，
// 避免子模块反向 import view.ts 造成循环）。
export function compactPath(p: string): string {
  const parts = p.split("/");
  if (parts.length <= 2) return p;
  return ".../" + parts.slice(-2).join("/");
}
