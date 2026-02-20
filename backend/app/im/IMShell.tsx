import type { ReactNode } from "react";

type IMShellProps = {
  left: ReactNode;
  mid: ReactNode;
  right: ReactNode;
};

export function IMShell({ left, mid, right }: IMShellProps) {
  return (
    <div className="app dark swarm-lab-im">
      {left}
      {mid}
      {right}
    </div>
  );
}
