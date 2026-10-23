import {
  AlertCircle as StillAlertCircle,
  ArrowUp as StillArrowUp,
  Blocks as StillBlocks,
  BookOpen as StillBookOpen,
  Brain as StillBrain,
  Check as StillCheck,
  CheckCircle2 as StillCheckCircle2,
  ChevronDown as StillChevronDown,
  ChevronRight as StillChevronRight,
  ChevronUp as StillChevronUp,
  Command as StillCommand,
  Copy as StillCopy,
  Download as StillDownload,
  Edit3 as StillEdit3,
  ExternalLink as StillExternalLink,
  FileImage as StillFileImage,
  FileText as StillFileText,
  FolderOpen as StillFolderOpen,
  Heading2 as StillHeading2,
  History as StillHistory,
  Image as StillImage,
  Info as StillInfo,
  Link2 as StillLink2,
  List as StillList,
  LogOut as StillLogOut,
  Megaphone as StillMegaphone,
  Menu as StillMenu,
  MessageSquare as StillMessageSquare,
  PanelLeft as StillPanelLeft,
  Pause as StillPause,
  Play as StillPlay,
  Plus as StillPlus,
  Receipt as StillReceipt,
  RefreshCw as StillRefreshCw,
  RotateCw as StillRotateCw,
  Save as StillSave,
  ScanText as StillScanText,
  Search as StillSearch,
  Share2 as StillShare2,
  ShieldCheck as StillShieldCheck,
  SlidersHorizontal as StillSlidersHorizontal,
  Sparkles as StillSparkles,
  Square as StillSquare,
  Table as StillTable,
  Trash2 as StillTrash2,
  Unlink as StillUnlink,
  Upload as StillUpload,
  Users as StillUsers,
  X as StillX,
} from 'lucide-react';
import { forwardRef, useCallback, useEffect, useRef } from 'react';
import type { LucideIcon, LucideProps } from 'lucide-react';
import { useReducedMotion } from './reduced-motion.ts';

export type { LucideIcon, LucideProps } from 'lucide-react';
// A loading indicator follows real work, rather than the interaction animation below.
export { LoaderCircle } from 'lucide-react';

// Shared with Desktop (desktop/src/icons.tsx). Individual CSS transforms compose with stateful ones.
const movements = {
  pulse: { scale: ['1', '1.12', '1'] },
  turn: { rotate: ['0deg', '15deg', '-8deg', '0deg'] },
  add: { rotate: ['0deg', '90deg', '0deg'], scale: ['1', '1.08', '1'] },
  refresh: { rotate: ['0deg', '180deg', '0deg'] },
  right: { translate: ['0px', '2px', '0px'] },
  up: { translate: ['0px 0px', '0px -2px', '0px 0px'] },
  down: { translate: ['0px 0px', '0px 2px', '0px 0px'] },
  document: { translate: ['0px 0px', '0px -1px', '0px 0px'], rotate: ['0deg', '-4deg', '0deg'] },
};
type Movement = keyof typeof movements;

/** Keep the Lucide drawing, SVG props and hit target; play one movement on its control's hover or focus. */
function animated(Drawing: LucideIcon, name: string, movement: Movement = 'pulse'): LucideIcon {
  const Icon = forwardRef<SVGSVGElement, LucideProps>(({ className, ...props }, ref) => {
    const svg = useRef<SVGSVGElement | null>(null);
    const reduced = useReducedMotion();
    const spinning = className?.split(/\s+/).includes('spin');
    const setRef = useCallback(
      (node: SVGSVGElement | null) => {
        svg.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) ref.current = node;
      },
      [ref],
    );
    useEffect(() => {
      if (reduced || spinning) return;
      const node = svg.current;
      const host = node?.closest<HTMLElement>(
        'button, a[href], summary, [role="button"], [role="tab"], [role="radio"], label:has(input)',
      );
      if (!node || !host || typeof node.animate !== 'function') return;
      let running: Animation | undefined;
      const play = () => {
        if (host.matches(':disabled, [aria-disabled="true"], label:has(input:disabled)')) return;
        running?.cancel();
        running = node.animate(movements[movement], { duration: 400, easing: 'ease-in-out' });
      };
      const stop = () => running?.cancel();
      host.addEventListener('pointerenter', play);
      host.addEventListener('pointerleave', stop);
      host.addEventListener('focusin', play);
      host.addEventListener('focusout', stop);
      return () => {
        host.removeEventListener('pointerenter', play);
        host.removeEventListener('pointerleave', stop);
        host.removeEventListener('focusin', play);
        host.removeEventListener('focusout', stop);
        running?.cancel();
      };
    }, [reduced, spinning]);
    return (
      <Drawing
        {...props}
        ref={setRef}
        className={className}
        style={{ transformOrigin: 'center', ...props.style }}
      />
    );
  });
  Icon.displayName = `Motion${name}`;
  return Icon;
}

export const AlertCircle = /* @__PURE__ */ animated(StillAlertCircle, 'AlertCircle', 'pulse');
export const ArrowUp = /* @__PURE__ */ animated(StillArrowUp, 'ArrowUp', 'up');
export const Blocks = /* @__PURE__ */ animated(StillBlocks, 'Blocks', 'pulse');
export const BookOpen = /* @__PURE__ */ animated(StillBookOpen, 'BookOpen', 'document');
export const Brain = /* @__PURE__ */ animated(StillBrain, 'Brain', 'pulse');
export const Check = /* @__PURE__ */ animated(StillCheck, 'Check', 'pulse');
export const CheckCircle2 = /* @__PURE__ */ animated(StillCheckCircle2, 'CheckCircle2', 'pulse');
export const ChevronDown = /* @__PURE__ */ animated(StillChevronDown, 'ChevronDown', 'down');
export const ChevronRight = /* @__PURE__ */ animated(StillChevronRight, 'ChevronRight', 'right');
export const ChevronUp = /* @__PURE__ */ animated(StillChevronUp, 'ChevronUp', 'up');
export const Command = /* @__PURE__ */ animated(StillCommand, 'Command', 'pulse');
export const Copy = /* @__PURE__ */ animated(StillCopy, 'Copy', 'document');
export const Download = /* @__PURE__ */ animated(StillDownload, 'Download', 'down');
export const Edit3 = /* @__PURE__ */ animated(StillEdit3, 'Edit3', 'pulse');
export const ExternalLink = /* @__PURE__ */ animated(StillExternalLink, 'ExternalLink', 'right');
export const FileImage = /* @__PURE__ */ animated(StillFileImage, 'FileImage', 'document');
export const FileText = /* @__PURE__ */ animated(StillFileText, 'FileText', 'document');
export const FolderOpen = /* @__PURE__ */ animated(StillFolderOpen, 'FolderOpen', 'document');
export const Heading2 = /* @__PURE__ */ animated(StillHeading2, 'Heading2', 'pulse');
export const History = /* @__PURE__ */ animated(StillHistory, 'History', 'refresh');
export const Image = /* @__PURE__ */ animated(StillImage, 'Image', 'document');
export const Info = /* @__PURE__ */ animated(StillInfo, 'Info', 'pulse');
export const Link2 = /* @__PURE__ */ animated(StillLink2, 'Link2', 'turn');
export const List = /* @__PURE__ */ animated(StillList, 'List', 'pulse');
export const LogOut = /* @__PURE__ */ animated(StillLogOut, 'LogOut', 'right');
export const Megaphone = /* @__PURE__ */ animated(StillMegaphone, 'Megaphone', 'document');
export const Menu = /* @__PURE__ */ animated(StillMenu, 'Menu', 'pulse');
export const MessageSquare = /* @__PURE__ */ animated(StillMessageSquare, 'MessageSquare', 'pulse');
export const PanelLeft = /* @__PURE__ */ animated(StillPanelLeft, 'PanelLeft', 'pulse');
export const Pause = /* @__PURE__ */ animated(StillPause, 'Pause', 'pulse');
export const Play = /* @__PURE__ */ animated(StillPlay, 'Play', 'pulse');
export const Plus = /* @__PURE__ */ animated(StillPlus, 'Plus', 'add');
export const Receipt = /* @__PURE__ */ animated(StillReceipt, 'Receipt', 'document');
export const RefreshCw = /* @__PURE__ */ animated(StillRefreshCw, 'RefreshCw', 'refresh');
export const RotateCw = /* @__PURE__ */ animated(StillRotateCw, 'RotateCw', 'refresh');
export const Save = /* @__PURE__ */ animated(StillSave, 'Save', 'down');
export const ScanText = /* @__PURE__ */ animated(StillScanText, 'ScanText', 'pulse');
export const Search = /* @__PURE__ */ animated(StillSearch, 'Search', 'pulse');
export const Share2 = /* @__PURE__ */ animated(StillShare2, 'Share2', 'pulse');
export const ShieldCheck = /* @__PURE__ */ animated(StillShieldCheck, 'ShieldCheck', 'pulse');
export const SlidersHorizontal = /* @__PURE__ */ animated(
  StillSlidersHorizontal,
  'SlidersHorizontal',
  'turn',
);
export const Sparkles = /* @__PURE__ */ animated(StillSparkles, 'Sparkles', 'pulse');
export const Square = /* @__PURE__ */ animated(StillSquare, 'Square', 'pulse');
export const Table = /* @__PURE__ */ animated(StillTable, 'Table', 'pulse');
export const Trash2 = /* @__PURE__ */ animated(StillTrash2, 'Trash2', 'turn');
export const Unlink = /* @__PURE__ */ animated(StillUnlink, 'Unlink', 'turn');
export const Upload = /* @__PURE__ */ animated(StillUpload, 'Upload', 'up');
export const Users = /* @__PURE__ */ animated(StillUsers, 'Users', 'pulse');
export const X = /* @__PURE__ */ animated(StillX, 'X', 'add');
