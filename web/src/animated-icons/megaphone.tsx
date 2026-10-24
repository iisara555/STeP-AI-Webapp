import { motion, useAnimation, type Variants } from 'motion/react';
import type { HTMLAttributes } from 'react';
import { forwardRef, useCallback, useImperativeHandle, useRef } from 'react';

// Not from lucide-animated (it has no megaphone): the Lucide megaphone drawing with a short wiggle, written here in the
// same shape as the copied icons so the rail can drive it.
export interface MegaphoneIconHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

interface MegaphoneIconProps extends HTMLAttributes<HTMLDivElement> {
  size?: number;
}

const WIGGLE_VARIANTS: Variants = {
  normal: { rotate: 0, transition: { duration: 0.3 } },
  animate: { rotate: [0, -10, 8, -6, 0], transition: { duration: 0.6, ease: 'easeInOut' } },
};

const MegaphoneIcon = forwardRef<MegaphoneIconHandle, MegaphoneIconProps>(
  ({ onMouseEnter, onMouseLeave, className, size = 28, ...props }, ref) => {
    const controls = useAnimation();
    const isControlledRef = useRef(false);

    useImperativeHandle(ref, () => {
      isControlledRef.current = true;
      return {
        startAnimation: () => controls.start('animate'),
        stopAnimation: () => controls.start('normal'),
      };
    });

    const handleMouseEnter = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (isControlledRef.current) {
          onMouseEnter?.(e);
        } else {
          controls.start('animate');
        }
      },
      [controls, onMouseEnter],
    );

    const handleMouseLeave = useCallback(
      (e: React.MouseEvent<HTMLDivElement>) => {
        if (isControlledRef.current) {
          onMouseLeave?.(e);
        } else {
          controls.start('normal');
        }
      },
      [controls, onMouseLeave],
    );

    return (
      <div className={className} onMouseEnter={handleMouseEnter} onMouseLeave={handleMouseLeave} {...props}>
        <motion.svg
          animate={controls}
          fill="none"
          height={size}
          initial="normal"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          style={{ originX: '20%', originY: '50%' }}
          variants={WIGGLE_VARIANTS}
          viewBox="0 0 24 24"
          width={size}
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M11 6a13 13 0 0 0 8.4-2.8A1 1 0 0 1 21 4v12a1 1 0 0 1-1.6.8A13 13 0 0 0 11 14H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" />
          <path d="M6 14a12 12 0 0 0 2.4 7.2 2 2 0 0 0 3.2-2.4A8 8 0 0 1 10 14" />
          <path d="M8 6v8" />
        </motion.svg>
      </div>
    );
  },
);

MegaphoneIcon.displayName = 'MegaphoneIcon';

export { MegaphoneIcon };
