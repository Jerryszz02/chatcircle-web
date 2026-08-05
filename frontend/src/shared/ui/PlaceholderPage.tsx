type PlaceholderPageProps = {
  /** 所属端：参与者端 / 机构管理端 / 超级管理端 */
  section: string;
  /** 页面名称 */
  title: string;
};

/** M0 占位页面：标明分区与页面名，实现里程碑推进时逐页替换。 */
export function PlaceholderPage({ section, title }: PlaceholderPageProps) {
  return (
    <main className="page">
      <p className="page-section">{section}</p>
      <h1>{title}</h1>
      <p>开发中</p>
    </main>
  );
}
