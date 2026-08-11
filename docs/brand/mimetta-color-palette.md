# Mimetta Design System — Color Palette

Tailwind tokens (tailwind.config.ts -> theme.extend.colors.brand):

| Token        | Hex     | Role                                                                                                                                                                        |
| ------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| brand.brown  | #1F3A2B | Primary actions — primary buttons, active nav underline, active tab underline, small circular status indicators. Never used as a background on cards, page sections, or the nav bar. |
| brand.accent | #BD5A2E | Hover state for primary buttons (swap, not dim), pinned badges, "Clear all" link.                                                                                            |
| brand.cream  | #FAF8F4 | Page/body background only — never a card, input, or table background.                                                                                                        |
| brand.border | #D8CBB0 | The one border color everywhere — cards, inputs, tables, dividers, nav bottom border.                                                                                        |
| brand.sage   | #9CAE8C | Success/positive indicators, e.g. a "Paid"/"Approved" badge.                                                                                                                 |
| brand.dark   | #1A1A1A | Body text, headings.                                                                                                                                                        |
| brand.muted  | #6B7280 | Secondary text, inactive nav/tab labels.                                                                                                                                    |
| brand.subtle | #9CA3AF | Placeholder text, uppercase section labels/counts.                                                                                                                          |

Non-token hexes: white #FFFFFF (only card/input/nav/modal background); #F9F8F6 table header
rows; #DC2626 destructive; #DBEAFE/#3B82F6 info banner; #FEF3C7/#F59E0B/#92400E warning
banner; #D1FAE5/#065F46 success badge; #FEF2F2 danger-hover bg.

Rules: cream = page bg only; white = only surface bg; brand.brown never a large background;
brand.border is the single border color; hovers swap color (green -> terracotta) rather than
dim.

Typography: DM Sans 400/500/600/700 + Noto Sans Thai fallback via next/font/google. Nav
56px; content max 1280px; card radius 10px; input height 36px; card padding px-6 py-5.
