"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

import type { AdminCapabilityView } from "@/contracts";

import { capabilityBlockReason, findCapabilityState } from "./capability-view";
import { AdminIcon } from "./icons";
import {
  ADMIN_IMPLEMENTED_PAGES,
  ADMIN_NAV_ITEMS,
  isNavGroupExpanded,
  isNavItemActive,
  type AdminNavItem,
} from "./nav-items";

const ACTIVE = "bg-blue-50 text-blue-700";
const IDLE = "text-gray-600 hover:bg-gray-100";

function itemState(item: AdminNavItem, capabilities: readonly AdminCapabilityView[]) {
  const blocked = item.capability
    ? capabilityBlockReason(item.capability, findCapabilityState(capabilities, item.capability))
    : null;
  const notBuilt = !ADMIN_IMPLEMENTED_PAGES.includes(item.href) && !item.children;
  const reason = blocked ?? (item.placeholder ? `${item.label}：${item.placeholder}` : null);
  // A blocked entry stays visible: hiding it would make an operator think the
  // feature does not exist rather than that they lack a capability.
  return { disabled: Boolean(blocked) || notBuilt, reason, blocked: Boolean(blocked) };
}

export function AdminSidebar({
  capabilities,
  version,
}: {
  capabilities: readonly AdminCapabilityView[];
  version: string;
}) {
  const pathname = usePathname() ?? "";
  const [collapsed, setCollapsed] = useState(false);

  return (
    <nav
      aria-label="后台导航"
      className={`flex shrink-0 flex-col border-r border-gray-200 bg-white transition-all ${
        collapsed ? "w-16" : "w-60"
      }`}
    >
      <div className="flex items-center justify-between gap-2 border-b border-gray-200 px-3 py-3">
        {!collapsed && (
          <span className="text-xs font-normal text-gray-400" title="构建版本">
            {version}
          </span>
        )}
        <button
          type="button"
          aria-label={collapsed ? "展开侧栏" : "收起侧栏"}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((value) => !value)}
          className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100"
        >
          <AdminIcon name="chevron" className={`h-4 w-4 ${collapsed ? "" : "rotate-180"}`} />
        </button>
      </div>

      <ul className="flex-1 space-y-0.5 overflow-y-auto p-2">
        {ADMIN_NAV_ITEMS.map((item) => {
          const active = isNavItemActive(pathname, item);
          const expanded = isNavGroupExpanded(pathname, item);
          const { disabled, reason, blocked } = itemState(item, capabilities);
          const className = `flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm ${
            active ? ACTIVE : IDLE
          } ${disabled ? "cursor-not-allowed opacity-50" : ""}`;

          return (
            <li key={item.href}>
              {disabled ? (
                <span className={className} title={reason ?? "本期未建"} aria-disabled="true">
                  <AdminIcon name={item.icon} />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                  {!collapsed && blocked && (
                    <span className="ml-auto text-[10px] text-gray-400">受限</span>
                  )}
                </span>
              ) : (
                <Link href={item.href} className={className} aria-current={active ? "page" : undefined}>
                  <AdminIcon name={item.icon} />
                  {!collapsed && <span className="truncate">{item.label}</span>}
                </Link>
              )}

              {!collapsed && item.children && expanded && (
                <ul className="mt-0.5 space-y-0.5 border-l border-gray-200 pl-4">
                  {item.children.map((child) => {
                    const childActive = isNavItemActive(pathname, child);
                    const childState = itemState(child, capabilities);
                    return (
                      <li key={child.href}>
                        <span
                          className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm ${
                            childActive ? ACTIVE : IDLE
                          } ${childState.disabled ? "cursor-not-allowed opacity-50" : ""}`}
                          title={childState.reason ?? "本期未建"}
                          aria-disabled="true"
                        >
                          <span className="truncate">{child.label}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
