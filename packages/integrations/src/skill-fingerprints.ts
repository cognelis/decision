/**
 * Every version of each bundled skill Paraself has shipped, file by file (sha256). A folder in a client's skills
 * matching one of these exactly is Paraself's own copy, to replace with the current one; anything else is the
 * reader's. Append the new fingerprint whenever a bundled skill changes (a test checks the bundle is listed); never
 * remove one, or copies of that version are taken for the reader's and left behind.
 */
export type SkillFingerprint = Record<string, string>;

/** The skill shipped as `decision-context` until 1.2.0, renamed `paraself-memory`. */
export const LEGACY_SKILL = { from: "decision-context", to: "paraself-memory" } as const;

export const SKILL_FINGERPRINTS: Record<string, readonly SkillFingerprint[]> = {
  // Each version of its SKILL.md in git history (the only file it had); the newest is 1.2.0's Resources/skills copy.
  "decision-context": [
    { "SKILL.md": "e2887843f253f049eb440849a2e733ff667c859eca2e28a35dbe31034b76a692" }, // 5ed73f2c
    { "SKILL.md": "238b47da3dd73aa9e401b8b153248767caa32ec8a41c975eeba724a10cab56ea" }, // 79767887
    { "SKILL.md": "2a7f23f55670476f5de4c48be5ea0245cef797c87721cc11206b6724fb78854a" }, // b48f4be0
    { "SKILL.md": "1ce4a8f5f13e2ee2a728fb34d64efc26c9fce5b243fd290fc9cfcdb79973b1af" }, // 8a25ee7d
    { "SKILL.md": "de044dcad43fe021db46c63d202524eb15dd3b610fe759b4ce4483811b144719" }, // bf798d6a
    { "SKILL.md": "1bda707439fb8a33022858a66352d733f59c247f60e877a1c546f2e40d46c6cb" }, // d10bb657
    { "SKILL.md": "3fa3151e85b514c3662d189617260336e7daccc03966690e77afd5202a0937c3" }, // 28796df9
    { "SKILL.md": "e2491f0ffa8cbec27374bbb3c89a502ceb6d1e1e9eb27e0fc427fa81921f0ef2" }, // 5001be0e
  ],
  "paraself-memory": [
    {
      "SKILL.md": "a237f6c146a13ab72f039c943fb57d48c8297a87d73c08e080c72c1cad1f3b61",
      "agents/openai.yaml": "1ee8059642832db6adbf7e9ad303ad52da8cfde1a0cb8a382891c86295270293",
      "references/recording.md": "52dc591c6764fa61f39468fe5752ee2c4fbf486b599cc5599e6c0b1713156c64",
    },
    {
      "SKILL.md": "4ed2978cdf82604ab188f71880058c626ae103cf56153bc844a6fccf22dea655",
      "agents/openai.yaml": "1ee8059642832db6adbf7e9ad303ad52da8cfde1a0cb8a382891c86295270293",
      "references/recording.md": "fa88372b604bd35bb1709511d9e60357142dc3197fc3b2393b6b7e514d55ae51",
      "references/review-benchmark.md": "28d7d43f0502215d15eccff3bd92868d0c7f87fc53c8ce881a555f89c57a235e",
    },
    {
      "SKILL.md": "4ed2978cdf82604ab188f71880058c626ae103cf56153bc844a6fccf22dea655",
      "agents/openai.yaml": "1ee8059642832db6adbf7e9ad303ad52da8cfde1a0cb8a382891c86295270293",
      "references/recording.md": "fa88372b604bd35bb1709511d9e60357142dc3197fc3b2393b6b7e514d55ae51",
      "references/review-benchmark.md": "54921c957ef799304c9664f8d912a894369418a65be3945783a508d9d8bd17ed",
    },
    // 历史决定：record / list / get / update_historical_decision 的用法。
    {
      "SKILL.md": "7e9649806fa0867edbe0b81e5731259e0a468476f71c04411723a9840c5eb8a0",
      "agents/openai.yaml": "1ee8059642832db6adbf7e9ad303ad52da8cfde1a0cb8a382891c86295270293",
      "references/recording.md": "16f5019f8ca4711444466a2b70e36da2b92c6731513fbcdd499baf9e7ac73f53",
      "references/review-benchmark.md": "54921c957ef799304c9664f8d912a894369418a65be3945783a508d9d8bd17ed",
    },
    // 历史决定：open_historical_decision、变更历史的范围，以及检索结果里旧类型改名后不再需要的提醒。
    {
      "SKILL.md": "d5dee9232aa278843cb08fee5ac8fcb21e3cd93169acbad005f0f4fee2a039cc",
      "agents/openai.yaml": "1ee8059642832db6adbf7e9ad303ad52da8cfde1a0cb8a382891c86295270293",
      "references/recording.md": "16f5019f8ca4711444466a2b70e36da2b92c6731513fbcdd499baf9e7ac73f53",
      "references/review-benchmark.md": "54921c957ef799304c9664f8d912a894369418a65be3945783a508d9d8bd17ed",
    },
    // 命名梳理：泛指以往的决策写 past decisions，不再与历史决定（historical decision）同名。
    {
      "SKILL.md": "d5dee9232aa278843cb08fee5ac8fcb21e3cd93169acbad005f0f4fee2a039cc",
      "agents/openai.yaml": "1ee8059642832db6adbf7e9ad303ad52da8cfde1a0cb8a382891c86295270293",
      "references/recording.md": "e41126f4e2d10accadd3a2444213273c41533d0b890d472a0a135005dacd0a7c",
      "references/review-benchmark.md": "54921c957ef799304c9664f8d912a894369418a65be3945783a508d9d8bd17ed",
    },
  ],
  "paraself-review": [
    {
      "SKILL.md": "18c9768d416914420f9d092a79c1dd406ecaae17aaca51a2dc7212adf3105cdf",
      "agents/openai.yaml": "5e2b6bd725e40da22238965c215ce88a72b7d99be549ea4f3a9dec084533ad63",
    },
    {
      "SKILL.md": "7da6ba0863e8f8ae04c7fc5c92170ca41a68b7d8f8701db95735906b8b1f55a1",
      "agents/openai.yaml": "5e2b6bd725e40da22238965c215ce88a72b7d99be549ea4f3a9dec084533ad63",
    },
    {
      "SKILL.md": "f2e51e1d437bf375b54f5026a0807f6dc8cbc94aa921065b9bc3a830ba93ef5c",
      "agents/openai.yaml": "5e2b6bd725e40da22238965c215ce88a72b7d99be549ea4f3a9dec084533ad63",
    },
    {
      "SKILL.md": "12e76eba862d9f2127799b204df93c44a0007ba8f076412c802f69c8e104eb84",
      "agents/openai.yaml": "5e2b6bd725e40da22238965c215ce88a72b7d99be549ea4f3a9dec084533ad63",
    },
    {
      "SKILL.md": "a7f571961cb4fad3180536c49af8c4d879b2e88f8c8aeba2ed855d09266b6f16",
      "agents/openai.yaml": "5e2b6bd725e40da22238965c215ce88a72b7d99be549ea4f3a9dec084533ad63",
    },
    {
      "SKILL.md": "4cb393da6cf180f67dd521e7e52e35c7228d671a7d4fd682e6a1767718f82b09",
      "agents/openai.yaml": "5e2b6bd725e40da22238965c215ce88a72b7d99be549ea4f3a9dec084533ad63",
    },
    {
      "SKILL.md": "096c5ea9f846272b86606fac0e3c53a114ba63293df4de77cb6c9f81107e78d2",
      "agents/openai.yaml": "5e2b6bd725e40da22238965c215ce88a72b7d99be549ea4f3a9dec084533ad63",
    },
    {
      "SKILL.md": "54a03a2681bc8473f8ad6ba59c6eaddc950926dfff3e80bf7fbfa8c13804ebd5",
      "agents/openai.yaml": "5e2b6bd725e40da22238965c215ce88a72b7d99be549ea4f3a9dec084533ad63",
    },
    {
      "SKILL.md": "5fcfd3d1c506bd3e2bf2adf5334610d85a64cd393e5179e5aef2ffc7e58ec751",
      "agents/openai.yaml": "5e2b6bd725e40da22238965c215ce88a72b7d99be549ea4f3a9dec084533ad63",
    },
    {
      "SKILL.md": "ddba78f9ad85f501751b304e93fffdb58bef9c580cb261b5e86b5e0b887b1e61",
      "agents/openai.yaml": "5e2b6bd725e40da22238965c215ce88a72b7d99be549ea4f3a9dec084533ad63",
    },
    {
      "SKILL.md": "45bbca3c40b561604fb2d72d89aa58d5dbc42018edc30f436eabd85d2d8bcc33",
      "agents/openai.yaml": "5e2b6bd725e40da22238965c215ce88a72b7d99be549ea4f3a9dec084533ad63",
    },
    {
      "SKILL.md": "592e5077bf09dbdaa5ada0750c22563fb8197694f83c1319832db3c6020eab2e",
      "agents/openai.yaml": "5e2b6bd725e40da22238965c215ce88a72b7d99be549ea4f3a9dec084533ad63",
    },
    {
      "SKILL.md": "6c5fccdfde8ab320f833ad911ce61b0d254f693bbb5a95ebed260d50f9fa1726",
      "agents/openai.yaml": "5e2b6bd725e40da22238965c215ce88a72b7d99be549ea4f3a9dec084533ad63",
    },
  ],
};
