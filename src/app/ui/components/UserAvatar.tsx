import { useState } from "react";

interface Props {
  name: string;
  username: string;
  avatarUrl: string;
  /** 头像图片与占位字符共用的类名，由调用方统一传入以保证视觉一致。 */
  className: string;
}

/** 用户头像：有可用 URL 时显示图片，加载失败或缺失时回退为显示名首字母。 */
export function UserAvatar({ name, username, avatarUrl, className }: Props) {
  const [failed, setFailed] = useState(false);
  const initial = [...(name || username)][0]?.toUpperCase() ?? "?";
  if (avatarUrl && !failed) {
    return <img className={className} src={avatarUrl} alt="" onError={() => setFailed(true)} />;
  }
  return <span className={className} aria-hidden="true">{initial}</span>;
}
