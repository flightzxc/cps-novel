import { BrandLockup } from "@/components/BrandMark";
import { Container } from "@/components/Container";
import type { NavItem } from "@/features/public-ui/types";

/**
 * 页脚。刻意保持最小。
 *
 * 不放：应用下载模块、社交入口、订阅框、用户体系入口——这些都会暗示我们并不
 * 具备的能力。链接由调用方注入，组件不自行决定路由。
 */
export function SiteFooter({
  links = [],
  brandHref = "/",
  note,
}: {
  links?: NavItem[];
  brandHref?: string;
  /** 一行补充说明，例如内容来源声明。 */
  note?: string;
}) {
  return (
    <footer className="mt-20 border-t border-novel-border bg-novel-bg md:mt-28">
      <Container className="flex flex-col gap-6 py-10 md:flex-row md:items-center md:justify-between md:py-12">
        <BrandLockup size={24} href={brandHref} />

        {links.length > 0 ? (
          <nav aria-label="页脚导航">
            <ul className="flex list-none flex-wrap gap-x-6 gap-y-2 p-0">
              {links.map((link) => (
                <li key={link.href + link.label}>
                  <a
                    href={link.href}
                    className="text-sm text-novel-fg-muted transition-colors hover:text-novel-fg"
                  >
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        ) : null}
      </Container>

      {note ? (
        <Container className="pb-10 md:pb-12">
          <p className="text-xs text-novel-fg-subtle">{note}</p>
        </Container>
      ) : null}
    </footer>
  );
}
