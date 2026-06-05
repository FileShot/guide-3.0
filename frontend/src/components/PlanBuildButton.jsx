import { Hammer, Check } from 'lucide-react';
import useAppStore from '../stores/appStore';
import { isPlanFilePath, planPathsMatch } from '../utils/planPath';

/** Build / Built control for an open `.guide/plans/*.plan.md` tab (editor or diff header). */
export default function PlanBuildButton({ filePath }) {
  const planSession = useAppStore((s) => s.planSession);
  const chatStreaming = useAppStore((s) => s.chatStreaming);
  const requestPlanBuild = useAppStore((s) => s.requestPlanBuild);

  if (!filePath || !isPlanFilePath(filePath)) return null;
  if (!planSession || !planPathsMatch(planSession.path, filePath)) return null;

  const { status } = planSession;
  const isBuilt = status === 'building' || status === 'done';
  const canBuild = status === 'ready' && !chatStreaming;

  if (!isBuilt && !canBuild) return null;

  if (isBuilt) {
    return (
      <button
        type="button"
        disabled
        className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium text-vsc-success opacity-80 cursor-default"
        title="Plan build started"
      >
        <Check size={12} />
        Built
      </button>
    );
  }

  return (
    <button
      type="button"
      className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium text-vsc-accent hover:bg-vsc-accent/10 transition-colors"
      title="Build this plan"
      onClick={() => requestPlanBuild(planSession)}
    >
      <Hammer size={12} />
      Build
    </button>
  );
}
