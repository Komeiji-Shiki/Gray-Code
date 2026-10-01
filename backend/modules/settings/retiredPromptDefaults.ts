/**
 * 已退役的内置提示词默认值。
 *
 * 设置会把内置模式的模板、总结提示词和记忆提示词原样保存下来，所以默认值更新后，旧用户仍会使用
 * 当初保存的旧文本。这里按“规范化后的 sha256”记录历史上发布过的默认值：读取设置时，内容与某个
 * 旧默认值完全一致的字段会换成当前默认值；用户改过的内容哈希不同，保持原样。
 *
 * 修改 shared/defaultPromptTemplates.ts 或总结默认值时，把被替换掉的旧文本的哈希补进对应分组。
 * 规范化方式：统一换行为 \n 并去掉首尾空白（见 promptDigest）。模板转换为预设条目时会删除
 * WORKSPACE_FILES、OPEN_TABS、ACTIVE_EDITOR、DIAGNOSTICS、PINNED_FILES 占位符，删除后的版本同样登记。
 */

import { createHash } from 'node:crypto';

export type RetiredPromptKind = 'code' | 'design' | 'plan' | 'ask' | 'review' | 'dynamic' | 'summarize' | 'autoSummarize' | 'memory';

const RETIRED_PROMPT_DIGESTS: Record<RetiredPromptKind, readonly string[]> = {
    code: [
        '110ec7776d0d87596d4998d7e0195f2d40c7fa1b084634617e187c7312fe0daa',
        '177ba15eab6d3b6f8e46f7d44a8dd8fc56dbf87c2a0fb3000ff6dc604d1b1fe6',
        '197946803554ba68703eb715bacdd1ab425005e7764d8c46458992665c196b7a',
        '1ab7d3a414d504c1dbb6c83a28edbc547d5d6fd79369065167d15123e4c75c82',
        '1cb94d74f9a97360c7d5d37aca02dd0cdc4a585362353943acfea7a2420bdd96',
        '1ff9faa7c29f43b8624c1b0b9e4498398ff17c43f58f4d7ff15366f46f1e2769',
        '22c2bf63da5302960826934d0bf36173694ee3ac48f8aaf1f34a9d6664b0c05c',
        '2face989c2b686177b9be3b9b931e879630021d2855a28c3ad5265b858cc1311',
        '354940c83148d853f835dc62a4eabfbbb7861d913b8b5c339c6d2b390e420e09',
        '3e2a96157d52a5fc5c4f7b16a80dc0398c38314214071a7f2c475fd84163b5f6',
        '40c360d135dfe9750257bfee1c08486485e088b0973172f26e56ff581f947a0b',
        '576b55faf352a3ad29b79aeb7e744103b011678a81b9433c95646a75ef770f2b',
        '74a4ea6acd8686a1b9bbceea7c2171e1243f0d862aa97685373a6ced777d7ebf',
        '86f9268ae0f80bf4c5e793399499282f6b002fe62fc862f52f41479f3bc0adac',
        '8e695ca17711372c87b29c32bf18cd8f50698b176b62f74caef62c30dc38fc99',
        '92881e4199f3fea0fc9d2099921b1e5dabbe15b39ca4ba4b636882f791b467b7',
        '99b8fd0cdfdaa5f523200f215c6ae4ca92e1f7dd6c41ff9306453a85a6d02c31',
        'a4e9d6d83b066d2feccc80e369ee26652ff0473833d382d078ade7e7d9a17c7c',
        'a98e2d14ba0bbc8c7538fc8f0c8984ceb2e24a82911c797956949849098bbb87',
        'abc63cee7f41694087d81fe0afcf7d56d0b8acb4f2632c5029afa6f3ba647714',
        'c808a769ca588be2d485b342cdf61b1ac828d1d3390542e75db71f5d04c2653e',
        'd74ec240dbc253e67fab63eca9010797c56b5c13fdad55278a727bd3b42d06dd',
        'ed832d2aec390cb4343bd5271e4a5196c076a7b34518323c2876e3ecc586402b',
        'faf6ebfc48e6155e1c270bc85c81379893768cb1047779fe4a10d3919c1afd38',
    ],
    design: [
        '149e787fe3ec9038f63d43e7c1e7c2377ba7579b29f0cd837716536057f46c2f',
        '16c7e155b7fd70610aeea174528fd47c3a23a3275b630272fc2a5b766d0f5fff',
        '1e8922cb13942614464a6152173f7478cbb4d1f210d35748b6de3587359b2e5c',
        '386b125e0d277a20561eb4d5c8276a3f08c7efcea62bc20e20d12375a094e933',
        '5480f087d6687f97708d97efec9987e3639ee077dd04f4b5395eeabee8bc203c',
        'aef82f8431ab5eb7579e206d79ef1c39cbea37964a8baae68778054ca24e6236',
        'e08a028d93077bbdb8598dabdded5573f30323b6fc0c26e9720a329e1f19e421',
        'ed680a9df6eafd766b27eed2927b5cda5293e9cfd569e2bb3440a2124c99f74f',
    ],
    plan: [
        '02dfeac33df9b5b80b2b3cb3e3fca6bc8633afcbdc31737105dda3e2fd2e13fd',
        '09d0441410274b44c89fda7ddf8c2ab52008555eaf62070edfe95930537af43e',
        '134539c42d74e4aee1bbfd1ce8e56e64b361615ec0c7a450b0c701db86e884fd',
        '28809483d63ec093a34b9413d6dbe92800b03bf03c6a769610a058d6ab3e783e',
        '2cf2fd1fb7c1d2da8c472f5e04cd3a2a02389b9e0511678dd1ab1c3f3a4dff10',
        '2ea762b3b5cee3cdccec029143c08926ff737cf9745e17be84742dac19e455b2',
        '33d74497f0c68c25be02f944b4352f6d35f62bb7d88b7c00b80445708f2f02f3',
        '44f599bea6cca7b71e15225ba7576c29ff613630c14bac99e1bfceaa2a35f02d',
        '46e9092cd91b58973bd291d87c614c2cbc19f2f77d558b79a4deb4ced0b2b66d',
        '4f0d195492569ee67a6fbde08f7e9b6b86b12f86632194f0fbb3fa5443624d43',
        '5d621b793137fad490c958d61ebb050ae256eb6e06271dcb2c0d18e81abe1a04',
        '6649dc78c2c388d898ba8e7a48d43acac6571fbc21594d486d1febfdd2560775',
        '6bb3682e3431e8f4c9ae756ae2be626aa5b3448b90f0dddc7f8210ab15d74e9e',
        '8938fcd5855847d3ea5a92fa3d0aa742a1ed6f62041166b47809d492fa153594',
        '9c58579d4c839886cc91063797623ce7bce002a4f13e397fc5b33f51d4227f5c',
        'a6999113fb4f0da4382f1de8f07c6074042521132e613d63a6d2eb5b62e47cb8',
        'ca0ad37dca85f0ba65646bb06c478f3c731d8d4dd8b72207c69fb67b7ccbb692',
        'cc28de2cd2cc04d0bdc56b047a95009eacf158e842268805ac427186618845c5',
        'f4cfa181ca19b72119794f4c26219c31b759962fc665320a68f7d96f1c30dc3c',
        'f8d2168aa49700ec114aa9bcf899277bf6b1d0483904c4b68879703d275b2db3',
    ],
    ask: [
        '29e72ba873c66f3aa005b3cd301c2b6d594f46cb9b7227c8924e273dda464b9b',
        'ae013666155bf2d8ce072b1dad2b00d5d5c806f0e6b5e98bec99ecf6be40da0e',
        'b673575477814ddc8f0db6899a0fda44e68edb34406bee3b4d9fd5f1ed3402d2',
        'bb21f5cc76411be2901153114325d2b9adf11148d6574f6bb720f96abdc06cbd',
        'c57b7b38e97df59d2ab35a12a35c4170e06dec756c757b3cb3bba52fd4424348',
    ],
    review: [
        '51a0cc946597eda2b640580868ba028cb72df8b0d1ad71cdaeee65f9e5a7e1e3',
        '51b8b387ff386a70fe200ab2ece57e88366a504f2d52e144c8c646a42dcb5055',
        'c13ec39a5d3fbc44790b7e59af7f4ec36e6b9873e6778e6928c3c0351b375831',
        'e498c4c22e3eb731b51c0da9e2f769c2ac82816534fc5b53b09b882d8ffcf575',
        'f08846b65632cffc73313ead2fb8fd00bbc4ffa6703a575ef93f88ac0d9f5761',
    ],
    dynamic: [
        '3e55a77e5bf87201f90fa449d2e71c6fe528a753e119a088b8930b66c3807843',
        '51180fec149d79fab869c7075b38c60a8c978d13c2c178c1c56ba842e216d670',
        '62a1b202622f3acee7a3f346fd25e9df9ee097f9d9b969b7ff41fd1181d7d6ad',
        '656c454fc2385e545f1233324ef5fe16482e5e5eddd907a6ed70155317f309dc',
        '668d26cab27ca32e3ccd856c12b855c324b8222fd952f862bfc20c815a1ee4fd',
        '7026956e1eace6a7758abc6eaa25962790a2da5f248c9e5ed18fec74d63841df',
        '83f1335666b38de24c5388ad9ea1483648fcb6315a814353b6c38f547cc6fe44',
        '88c03260485bf06030e20308500397ede5522ad97bac5b73e93b21555f6f7f61',
        '947b35948751c2c67e66cd43a34cf8c761b07a171f6b2fbdef520b169cd1538b',
        'a05d91a99f102ceee148fcc4654cb1babec607e1ceabc81fba45f525c70f48c5',
        'a567b927ce6c9a8f7f10f3e165d2faeaf6b9e5866dc6b51bc5c6de6c527ee421',
        'af759cda32e6822108279afe6c773b9b5065cf653c64752bd0cf920622ea4f73',
        'af8a2d242f2a22d3e1454506803b1a30a39073b830652d753eb2b36ae1191301',
        'b8ed2338dda28b1387453bde54c7285287f076a19a0586a28ce5dc0327a84644',
        'c54894572b3a2c7abb8caee8b3bcab4cc3ed92a1bb7509e7fdb5f1d9d37a08eb',
        'dab370689aed9636e5f91956887e9cb109036ee4c43c9c3f71dc13fd855e439b',
        'df5b2ce6bc11aa11f312fd4354c6f4ef003c351f3f0a13eae9cb203d80cfa0d4',
        'e2b059ec0c65cbb4ac2222173cc3db0bcc0bb5efadcf3069c23bbfe8dc69a9b4',
    ],
    summarize: [
        '9afe9813416f54fc463e2a3d0ea7f23a41922c9e875ea4d6638b580b8281eced',
        'ad10bcb101df5fb725dfc013779c7fb1d399ae0c158662eaf24339cd5ff88591',
    ],
    autoSummarize: [
        'c81adc33ee55cd067e3202e7a449117dee3b0121c8af27d274378efb905970ac',
    ],
    memory: [
        '25d1080a7f4de3b2b50a0bb7a0ea0bb8ead3435eb682a87ec5b01d2ae63885b5',
        '7dbd661cc6c4a3d7b7151c0d8e03e859e13460f7fa1b80893203d1faf8fa7915',
        'ab4a9d537b921c3fae79cc07001e9a7a4ac6132f5eca54c191b5c5a0803234ac',
        'b9cf705e2f706dfbbf5bbc266969d301f834b105e85d63ad09ca5807d6783e5d',
        'c1eadacfa71b59c196fb8e1879312c0e0851f1b25bb5f45490c11dc2f3ebd8c3',
        'cb95a526cf5c0c93baa7cf83adfbdab50961115480944359c4ce53af832528bb',
        'd62b540e34191d4cda8192847cd8d3e33a74a0d013e5f61c90632caedbe9e161',
        'e93f0fac193d5963b399129a7c6ce830eb9d89a2a6e81b7f3027d994d2331611',
        'f58d176cf1a7e16304844577a6cf612cc0e39e5e9992b16b8b5a2c96389dd346',
    ],
};

const kindByDigest = new Map<string, RetiredPromptKind>(
    (Object.entries(RETIRED_PROMPT_DIGESTS) as Array<[RetiredPromptKind, readonly string[]]>)
        .flatMap(([kind, digests]) => digests.map(digest => [digest, kind] as const))
);

export function promptDigest(text: string): string {
    return createHash('sha256').update(text.replace(/\r\n/g, '\n').trim()).digest('hex');
}

/** 文本与某个已退役的默认值完全一致时返回它所属的分组，否则返回 undefined。 */
export function retiredPromptKind(text: unknown): RetiredPromptKind | undefined {
    return typeof text === 'string' && text.trim() ? kindByDigest.get(promptDigest(text)) : undefined;
}

/** 只在文本属于指定分组的旧默认值时换成 replacement，其余情况原样返回。 */
export function upgradeRetiredPrompt<T>(text: T, kinds: readonly RetiredPromptKind[], replacement: string): T | string {
    const kind = retiredPromptKind(text);
    return kind && kinds.includes(kind) ? replacement : text;
}
