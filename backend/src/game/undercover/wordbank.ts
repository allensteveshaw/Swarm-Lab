export type WordPair = {
  civilian: string;
  undercover: string;
  topic: string;
  difficulty: "easy" | "normal" | "hard";
  civilianHints: string[];
  undercoverHints: string[];
};

const DIFF_RANK: Record<WordPair["difficulty"], number> = {
  easy: 1,
  normal: 2,
  hard: 3,
};

export const WORD_PAIRS: WordPair[] = [
  { civilian: "牛奶", undercover: "豆浆", topic: "饮品", difficulty: "easy", civilianHints: ["白色", "早餐常见", "乳香明显"], undercoverHints: ["植物来源", "早餐常见", "豆香明显"] },
  { civilian: "西瓜", undercover: "哈密瓜", topic: "水果", difficulty: "easy", civilianHints: ["多汁", "夏季常见", "果皮更深色"], undercoverHints: ["更甜", "夏季常见", "果肉偏浅色"] },
  { civilian: "地铁", undercover: "高铁", topic: "交通", difficulty: "normal", civilianHints: ["城市内通勤", "站点密集", "高峰拥挤"], undercoverHints: ["跨城长途", "速度更快", "站点较少"] },
  { civilian: "篮球", undercover: "足球", topic: "运动", difficulty: "normal", civilianHints: ["手部控球", "得分频繁", "回合节奏快"], undercoverHints: ["脚部控球", "低比分常见", "场地更大"] },
  { civilian: "电影", undercover: "电视剧", topic: "内容", difficulty: "normal", civilianHints: ["单次完整", "时长集中", "院线属性强"], undercoverHints: ["多集连载", "追更属性", "平台属性强"] },
  { civilian: "雨伞", undercover: "雨衣", topic: "雨具", difficulty: "normal", civilianHints: ["手持", "遮挡上半身", "收纳后体积小"], undercoverHints: ["穿戴", "覆盖面积更大", "双手可空出"] },
  { civilian: "口红", undercover: "腮红", topic: "美妆", difficulty: "hard", civilianHints: ["用于唇部", "色号差异大", "补妆频率高"], undercoverHints: ["用于面颊", "强调气色", "上妆面积更广"] },
  { civilian: "火锅", undercover: "麻辣烫", topic: "餐饮", difficulty: "hard", civilianHints: ["多人社交", "锅底共享", "就餐时长偏长"], undercoverHints: ["单人快餐", "按串或按量", "就餐节奏快"] },
  { civilian: "滑板", undercover: "轮滑", topic: "运动装备", difficulty: "hard", civilianHints: ["双脚同板", "动作强调平衡", "场地自由度高"], undercoverHints: ["双脚分离", "鞋体一体化", "转向方式不同"] },
  { civilian: "咖啡", undercover: "茶", topic: "饮品", difficulty: "hard", civilianHints: ["苦感明显", "提神印象强", "烘焙香突出"], undercoverHints: ["清香层次", "浸泡时间敏感", "茶叶产地讨论多"] },
  { civilian: "耳机", undercover: "音箱", topic: "数码", difficulty: "hard", civilianHints: ["私密聆听", "贴耳或入耳", "更适合通勤"], undercoverHints: ["外放共享", "空间感更强", "更适合居家"] },
  { civilian: "冰箱", undercover: "冷柜", topic: "家电", difficulty: "hard", civilianHints: ["立式分层", "日常食材管理", "家庭常见"], undercoverHints: ["横向开盖", "囤货容量大", "商用场景更多"] },
  { civilian: "跑步机", undercover: "椭圆机", topic: "健身", difficulty: "hard", civilianHints: ["步幅接近跑步", "冲击感明显", "配速感强"], undercoverHints: ["轨迹更平滑", "冲击更小", "手脚联动"] },
  { civilian: "微信", undercover: "钉钉", topic: "应用", difficulty: "hard", civilianHints: ["社交关系链强", "私聊使用高频", "生活化场景多"], undercoverHints: ["组织协同强", "审批打卡常见", "办公化场景多"] },
  { civilian: "机械键盘", undercover: "薄膜键盘", topic: "外设", difficulty: "hard", civilianHints: ["段落感明显", "可换轴讨论多", "声音更突出"], undercoverHints: ["触感更软", "价格门槛低", "办公普及更高"] },
  { civilian: "露营", undercover: "野餐", topic: "户外", difficulty: "hard", civilianHints: ["过夜属性", "装备更重", "搭建流程复杂"], undercoverHints: ["半日活动", "装备更轻", "重在即食休闲"] },
];

export type PickWordPairOptions = {
  minDifficulty?: WordPair["difficulty"];
  preferHard?: boolean;
};

function deterministicIndex(seed: string, length: number) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return hash % Math.max(1, length);
}

export function pickWordPair(seed?: string, options?: PickWordPairOptions) {
  const minDiff = options?.minDifficulty ?? "normal";
  const preferHard = options?.preferHard ?? true;
  let pool = WORD_PAIRS.filter((x) => DIFF_RANK[x.difficulty] >= DIFF_RANK[minDiff]);
  if (pool.length === 0) pool = [...WORD_PAIRS];

  if (preferHard) {
    const hard = pool.filter((x) => x.difficulty === "hard");
    const normal = pool.filter((x) => x.difficulty === "normal");
    const easy = pool.filter((x) => x.difficulty === "easy");
    const weighted = [...hard, ...hard, ...hard, ...normal, ...normal, ...easy];
    if (weighted.length > 0) pool = weighted;
  }

  if (!seed) return pool[Math.floor(Math.random() * pool.length)]!;
  return pool[deterministicIndex(seed, pool.length)]!;
}
