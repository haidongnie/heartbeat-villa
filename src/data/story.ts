// Everything the show says: cast bible, host script, drama cards. Gameplay code only reads this.

export type CharId = 'linye' | 'sutang' | 'luxiao' | 'baizhi' | 'guchen' | 'xiaoman';

export interface CharDef {
  id: CharId;
  name: string;
  age: number;
  title: string;
  tag: string;
  motto: string;
  secret: string;
  color: string;
  /** Lines the AI says when nobody plays this character. */
  idle: string[];
  /** Initial crush strength towards other cast members (story ties). */
  crush: Partial<Record<CharId, number>>;
  /** Who they throw under the bus when blaming. */
  blame: CharId;
}

export const CAST: CharDef[] = [
  {
    id: 'linye', name: '林夜', age: 28, title: '霸道总裁', tag: '林氏集团继承人',
    motto: '我不缺钱，只缺一个让我心跳的人。', color: '#8a7dff',
    secret: '林氏集团上个月已秘密申请破产重组。他来节目，是为了找一个“有钱的另一半”。',
    idle: ['这里的香槟，配不上我。', '别误会，我只是路过。', '你在看我？', '我从不解释，除了对一个人。', '今晚的晚霞，像一份合同。'],
    crush: { baizhi: 3, sutang: 1.2, xiaoman: 0.5 }, blame: 'luxiao',
  },
  {
    id: 'sutang', name: '苏糖', age: 23, title: '甜心网红', tag: '300 万粉丝美妆博主',
    motto: '我是来找真爱的，不是来涨粉的～', color: '#ff7eb6',
    secret: '她和节目组签了一份“剧情合约”：每制造一次修罗场，奖金十万。',
    idle: ['宝宝们～这里的落日也太好看了吧！', '嘻嘻，你猜我在想谁？', '我不是故意的啦～', '有没有人陪我去泳池边拍照？', '这杯饮料是谁的？我先喝一口～'],
    crush: { linye: 2, guchen: 1.5, luxiao: 1 }, blame: 'xiaoman',
  },
  {
    id: 'luxiao', name: '陆骁', age: 25, title: '阳光冲浪少年', tag: '国家队退役冲浪运动员',
    motto: '喜欢就追，追不到就再追。', color: '#29c7c0',
    secret: '他是林夜同父异母的弟弟，林家从未承认过他。',
    idle: ['明早一起去看日出吗？', '海浪不会骗人，人会。', '我会一直等到你回头。', '谁要冲浪？我教你！', '有些人，从小就站在光里。'],
    crush: { baizhi: 2, xiaoman: 2, sutang: 0.6 }, blame: 'linye',
  },
  {
    id: 'baizhi', name: '白芷', age: 27, title: '清冷女医生', tag: '心外科主治医师',
    motto: '我治得好别人的心，治不好自己的。', color: '#b8c4d6',
    secret: '三年前在婚礼当天逃婚的新娘就是她，新郎是林夜。',
    idle: ['心跳过快，建议冷静一下。', '我只相信检查报告。', '有些伤口，缝合了也会疼。', '……别靠那么近。', '你的手很凉，是紧张吗？'],
    crush: { luxiao: 2, linye: 1.4, guchen: 0.6 }, blame: 'sutang',
  },
  {
    id: 'guchen', name: '顾辰', age: 26, title: '颓废乐队主唱', tag: '独立乐队“凌晨三点”主唱',
    motto: '我的歌只写给一个人。', color: '#ff9a4d',
    secret: '那首爆红的情歌《糖》写的是苏糖，他们曾秘密交往两年。',
    idle: ['这段旋律，送给某个人。', '我讨厌热闹，但喜欢看你笑。', '别问，问就是在写歌。', '有些人走了，歌还在。', '今晚适合失眠。'],
    crush: { sutang: 3, xiaoman: 1, baizhi: 0.8 }, blame: 'sutang',
  },
  {
    id: 'xiaoman', name: '夏小满', age: 22, title: '元气街舞女孩', tag: '街舞大赛冠军',
    motto: '谁惹我，我就跳到谁怀疑人生！', color: '#ffc531',
    secret: '第一晚她偷看了所有人的心动短信，而且偷偷改了一条。',
    idle: ['谁来 battle？', '我什么都没看到哦～', '这首歌我能跳一整晚！', '你们大人真复杂。', '嘘——我知道一个秘密。'],
    crush: { luxiao: 2, guchen: 1.2, linye: 0.5 }, blame: 'baizhi',
  },
];

export const CHAR = Object.fromEntries(CAST.map((c) => [c.id, c])) as Record<CharId, CharDef>;
export const CHAR_IDS = CAST.map((c) => c.id);

export const HOST = { id: 'molly', name: '茉莉', title: '主持人' } as const;

export const EPISODES: Record<number, { title: string; sub: string }> = {
  1: { title: '第一夜 · 初见', sub: '黄金时刻，所有人都在假装从容' },
  2: { title: '第二夜 · 爆料', sub: '大屏幕亮起的时候，有人的脸色变了' },
  3: { title: '第三夜 · 篝火真心话', sub: '酒瓶转向谁，谁就不能说谎' },
  4: { title: '终夜 · 心动告白', sub: '今晚之后，有人牵手，有人心碎' },
};

/** Host narration per phase. `{x}` placeholders are filled by the game. */
export const HOST_LINES = {
  intro: [
    '欢迎来到《心跳别墅》！我是主持人茉莉。',
    '四个夜晚，六位单身男女，一座藏着秘密的海岛别墅。',
    '这里没有剧本——只有心跳、谎言，和一块只说真话的大屏幕。',
    '请嘉宾们入住吧。记住：心跳别墅，从不缺心跳。',
  ],
  roam1: '自由交流时间！每人手里有一支玫瑰——当众送出，才算数。',
  text: '夜深了。请给你最心动的人，发一条匿名心动短信。',
  textReveal: '短信已送达。有人收到了很多……也有人，一条都没有。',
  leak: '叮——大屏幕收到一条匿名爆料。',
  respond: '{x}，镜头在你身上。你要怎么回应？',
  judge: '其他嘉宾请站队：你相信 {x} 吗？',
  storm: '暴雨预警！雷声盖住了心跳声……趁乱，说出你想说的话。',
  gather: '第三夜。请所有嘉宾到篝火旁坐下。',
  bottle: '酒瓶转起来了——停在谁面前，谁就要回答真心话。',
  confess: '终夜。这是最后一次选择。请写下你的告白对象。',
  confessReveal: '让我们揭晓，今晚的心动答案。',
  finale: '本季《心跳别墅》到此结束。谢谢你们，把心跳交给了这里。',
};

export interface TruthCard { q: string; kind: 'love' | 'shade' }
export const TRUTH_CARDS: TruthCard[] = [
  { q: '在场谁最让你心动？', kind: 'love' },
  { q: '谁最像是来“演戏”的？', kind: 'shade' },
  { q: '如果只能带一个人离开别墅，你带谁？', kind: 'love' },
  { q: '谁最会装？', kind: 'shade' },
  { q: '你最想偷看谁的心动短信？', kind: 'love' },
  { q: '在场谁最不可能是你的菜？', kind: 'shade' },
  { q: '今晚你最想和谁单独看海？', kind: 'love' },
  { q: '谁最可能在节目结束后翻脸？', kind: 'shade' },
];

export type LeakResponse = 'admit' | 'deny' | 'blame';
export const LEAK_RESPONSES: Record<LeakResponse, { label: string; say: string }> = {
  admit: { label: '承认：是真的，我认。', say: '……是真的。我不想再演了。' },
  deny: { label: '否认：这是污蔑！', say: '这是污蔑！谁在背后搞我？' },
  blame: { label: '甩锅：是有人故意放的消息！', say: '我知道是谁放的消息——{x}，是你吧？' },
};

/** Variety-show captions (花字) for big moments. */
export const HUAZI = {
  rose: ['心动了心动了', '玫瑰攻势!', '当众示爱!!', '这谁顶得住', '甜度超标'],
  leak: ['修罗场预警!!!', '空气突然安静', '大型翻车现场', '瓜来了!!!', '不可置信'],
  admit: ['勇敢!', '坦白局', '这波我敬你'],
  deny: ['嘴硬王者', '真的吗?', '你猜我信不信'],
  blame: ['甩锅大师', '战火蔓延', '修罗场升级!!'],
  storm: ['暴雨夜', '心跳加速', '氛围到了'],
  bottle: ['命运之瓶', '转转转!', '心跳一刻'],
  match: ['双向奔赴!!!', '磕到了!!!', '官宣!!', '本季最甜'],
  miss: ['心碎一地', '单向心动', '意难平', '泪目'],
  love: ['直球!', '心动暴击', '脸红了'],
  shade: ['火药味', '当面开撕', '杀人诛心'],
};

export const ENDINGS = {
  match: (a: string, b: string) => `清晨的码头，${a}和${b}十指相扣地走下台阶。镜头拉远，海面一片金光。`,
  oneSided: (a: string, b: string) => `${a}独自拖着行李箱，回头看了一眼别墅。${b}没有出来送别。`,
  chosenBy: (a: string, b: string) => `${a}没有回头，却不知道，${b}在篝火旁为TA心碎了一整晚。`,
  alone: (a: string) => `${a}把玫瑰留在了泳池边。“下一季，也许会遇见对的人。”`,
};

export const DRAMA_FLASH = [
  '📺 大屏幕：有人在泳池边偷偷哭了三分钟。',
  '📺 匿名信：别墅里有两个人，在节目开始前就认识。',
  '📺 节目组提醒：今晚的心动短信，有一条被人改过。',
  '📺 观众弹幕：“我赌五毛，今晚有人要翻脸。”',
  '📺 热搜第一：#心跳别墅 修罗场#',
];
