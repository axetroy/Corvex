import type { Copy } from "../lib/i18n.js";
import { PageHeading } from "../components/common.js";
import { ModelManager } from "../components/ModelManager.js";

interface Props {
  copy: Copy;
  onChanged: () => void;
}

/** 用户个人设置：只管理自己的模型目录，不影响系统全局配置。 */
export function UserSettingsPage({ copy, onChanged }: Props) {
  return (
    <div className="user-settings-page">
      <PageHeading title={copy.userSettingsTitle} description={copy.userSettingsDescription} />
      <ModelManager copy={copy} scope="user" onChanged={onChanged} />
    </div>
  );
}
