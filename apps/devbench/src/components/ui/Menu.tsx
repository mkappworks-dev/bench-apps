import { Menu as BaseMenu } from "@base-ui-components/react/menu";

export interface MenuOption {
  value: string;
  label: string;
  description?: string;
  icon?: React.ReactNode;
}

const ITEM_CLASS =
  "flex w-full cursor-pointer items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left text-sm " +
  "text-text-muted transition-colors duration-150 outline-none " +
  "data-[highlighted]:bg-surface-2 data-[highlighted]:text-text";

/**
 * Every dropdown in the app. Base UI supplies the behaviour a hand-rolled menu
 * reliably gets wrong — typeahead, arrow navigation, focus return on close,
 * escape-to-dismiss, and correct `menu`/`menuitem` wiring.
 *
 * Passing `value` switches the menu from an action list to a picker: it renders
 * radio items so exactly one option carries `aria-checked`. That is what makes
 * it a legitimate replacement for a native `<select>` rather than a lookalike.
 *
 * Glass, not ghosty — DESIGN.md reserves blur for transient overlays, which is
 * precisely what a menu is. The solid fallback under `prefers-reduced-transparency`
 * is required, not optional.
 */
export function Menu({
  label,
  options,
  value,
  onSelect,
  trigger,
  triggerClassName,
  align = "start",
}: {
  label: string;
  options: MenuOption[];
  value?: string;
  onSelect: (value: string) => void;
  trigger: React.ReactNode;
  triggerClassName?: string;
  align?: "start" | "end";
}) {
  const isPicker = value !== undefined;

  const body = options.map((option) =>
    isPicker ? (
      <BaseMenu.RadioItem key={option.value} value={option.value} className={ITEM_CLASS}>
        <OptionBody option={option} />
        <BaseMenu.RadioItemIndicator className="ml-auto text-text">
          <CheckIcon />
        </BaseMenu.RadioItemIndicator>
      </BaseMenu.RadioItem>
    ) : (
      <BaseMenu.Item key={option.value} className={ITEM_CLASS} onClick={() => onSelect(option.value)}>
        <OptionBody option={option} />
      </BaseMenu.Item>
    ),
  );

  return (
    <BaseMenu.Root>
      {/* No aria-label here: the trigger's accessible name must stay the
          visible trigger content ("Add", "POST", "Dark") so it behaves like a
          native <select> button. The descriptive `label` goes on the popup
          below instead, where it names the listbox for screen readers. */}
      <BaseMenu.Trigger className={triggerClassName}>{trigger}</BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner sideOffset={6} align={align} className="z-50">
          <BaseMenu.Popup
            aria-label={label}
            // Base UI auto-wires aria-labelledby from the popup to the trigger
            // (so the popup would otherwise inherit the trigger's own visible
            // text as its name). aria-labelledby wins over aria-label per the
            // accessible-name algorithm, so it must be cleared explicitly for
            // our descriptive `label` to be the popup's name.
            aria-labelledby={undefined}
            className="min-w-52 rounded-lg border border-border bg-surface p-1.5 shadow-lg backdrop-blur-[24px]"
          >
            <div className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider text-text-faint">
              {label}
            </div>
            {isPicker ? (
              <BaseMenu.RadioGroup value={value} onValueChange={(next) => onSelect(String(next))}>
                {body}
              </BaseMenu.RadioGroup>
            ) : (
              body
            )}
          </BaseMenu.Popup>
        </BaseMenu.Positioner>
      </BaseMenu.Portal>
    </BaseMenu.Root>
  );
}

function OptionBody({ option }: { option: MenuOption }) {
  return (
    <>
      {option.icon ? <span className="shrink-0 text-text-faint">{option.icon}</span> : null}
      <span>
        <span className="block font-medium text-text">{option.label}</span>
        {option.description ? (
          <span className="block text-xs text-text-faint">{option.description}</span>
        ) : null}
      </span>
    </>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

/** Exported because every Menu trigger in the app ends with one. */
export function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-text-faint">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
