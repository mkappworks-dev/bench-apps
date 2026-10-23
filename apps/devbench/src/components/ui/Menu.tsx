import { Menu as BaseMenu } from "@base-ui-components/react/menu";

export interface MenuOption {
  value: string;
  label: string;
  description?: string;
  icon?: React.ReactNode;
}

const ITEM_CLASS =
  "flex w-full cursor-pointer items-center gap-2.25 rounded-sm px-2.25 py-1.75 text-left text-[13.5px] " +
  "text-text-muted transition-colors duration-150 outline-none " +
  "data-[highlighted]:bg-surface-2 data-[highlighted]:text-text";

export function Menu({
  label,
  options,
  value,
  onSelect,
  trigger,
  triggerClassName,
  align = "start",
  open,
  onOpenChange,
  footerLabel,
  footerIcon,
  onFooterSelect,
}: {
  label: string;
  options: MenuOption[];
  value?: string;
  onSelect: (value: string) => void;
  trigger: React.ReactNode;
  triggerClassName?: string;
  align?: "start" | "end";
  /** An action below a separator, for the mockup's "Manage connections…"
   *  shape: a way out of the picker that isn't one of the values. */
  footerLabel?: string;
  footerIcon?: React.ReactNode;
  onFooterSelect?: () => void;
  /** Omit for the normal click-to-open case. Set only when a caller must
   *  open the menu without the user clicking its trigger (AppStrip's
   *  Split-declined flow). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const isPicker = value !== undefined;

  const body = options.map((option) =>
    isPicker ? (
      <BaseMenu.RadioItem key={option.value} value={option.value} className={ITEM_CLASS}>
        <OptionBody option={option} />
        <BaseMenu.RadioItemIndicator className="ml-auto text-text-faint">
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
    <BaseMenu.Root open={open} onOpenChange={onOpenChange}>
      {/* Named by what it controls: the visible text is only the current value. */}
      <BaseMenu.Trigger aria-label={label} className={triggerClassName}>
        {trigger}
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner sideOffset={6} align={align} className="z-50">
          <BaseMenu.Popup
            aria-label={label}
            className="min-w-55 rounded-lg border p-1.25 backdrop-blur-xl backdrop-saturate-150"
            style={{
              background: "color-mix(in srgb, var(--surface) 72%, transparent)",
              // Hairline glass border, not the opaque --border: a translucent
              // panel reads as lit from its own edge rather than cut out.
              borderColor: "var(--glass-border)",
              // Elevation and the inner top highlight together. Setting only
              // the inset here (with `shadow-lg` doing the rest) silently
              // dropped the elevation entirely — an inline boxShadow replaces
              // the utility's value rather than adding to it.
              boxShadow: "var(--shadow), var(--glass-hi)",
            }}
          >
            <div className="px-2.25 pb-1.25 pt-1.5 text-[10.5px] font-bold uppercase tracking-[0.06em] text-text-faint">
              {label}
            </div>
            {isPicker ? (
              <BaseMenu.RadioGroup value={value} onValueChange={(next) => onSelect(String(next))}>
                {body}
              </BaseMenu.RadioGroup>
            ) : (
              body
            )}
            {footerLabel && onFooterSelect ? (
              <>
                <div className="mx-0.75 my-1.25 h-px bg-border" />
                <BaseMenu.Item className={ITEM_CLASS} onClick={onFooterSelect}>
                  {footerIcon ? <span className="shrink-0 text-text-faint">{footerIcon}</span> : null}
                  <span>{footerLabel}</span>
                </BaseMenu.Item>
              </>
            ) : null}
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
      <span className="min-w-0">
        <span className="block truncate font-semibold text-text">{option.label}</span>
        {option.description ? (
          <span className="block truncate font-normal text-xs text-text-faint">{option.description}</span>
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

export function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-text-faint">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
