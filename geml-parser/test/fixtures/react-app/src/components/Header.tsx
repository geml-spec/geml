import { formatCount } from "../utils/format";
import { Logo } from "./Logo";

export function Header({ count }: { count: number }) {
  return (
    <header>
      <Logo />
      <h1>Todos</h1>
      <span>{formatCount(count)}</span>
    </header>
  );
}
