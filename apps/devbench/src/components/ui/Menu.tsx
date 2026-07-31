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
      {/* Named by what it controls: the visible text is only the current value. */}
      <BaseMenu.Trigger aria-label={label} className={triggerClassName}>
        {trigger}
      </BaseMenu.Trigger>
      <BaseMenu.Portal>
        <BaseMenu.Positioner sideOffset={6} align={align} className="z-50">
          <BaseMenu.Popup
            aria-label={label}
            className="min-w-52 rounded-lg border border-border p-1.5 shadow-lg backdrop-blur-xl backdrop-saturate-150"
            style={{
              background: "color-mix(in srgb, var(--surface) 72%, transparent)",
              boxShadow: "inset 0 1px 0 0 rgb(255 255 255 / 0.06)",
            }}
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

export function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-text-faint">
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}
