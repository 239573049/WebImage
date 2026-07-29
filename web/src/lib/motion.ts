import type { Transition, Variants } from "motion/react";

/** 统一的弹性过渡，用于侧栏/卡片等 UI 元素 */
export const springSoft: Transition = {
  type: "spring",
  stiffness: 380,
  damping: 32,
  mass: 0.8,
};

export const springSnappy: Transition = {
  type: "spring",
  stiffness: 520,
  damping: 36,
  mass: 0.7,
};

export const easeOut: Transition = {
  duration: 0.28,
  ease: [0.22, 1, 0.36, 1],
};

/** 页面内容区入场：只用透明度，避免 translateY 把滚动容器撑出多余滚动条 */
export const pageFadeUp: Variants = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { ...easeOut, staggerChildren: 0.06, delayChildren: 0.02 },
  },
};

export const fadeUpItem: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: easeOut },
};

/** 列表/表格行交错入场 */
export const listStagger: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.028, delayChildren: 0.02 },
  },
};

export const listItem: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.22, ease: [0.22, 1, 0.36, 1] } },
};

/** 侧栏导航项 */
export const navItemVariants: Variants = {
  hidden: { opacity: 0, x: -8 },
  show: { opacity: 1, x: 0, transition: springSoft },
};

export const navListVariants: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.04, delayChildren: 0.05 },
  },
};
