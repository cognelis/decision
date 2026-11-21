`main/settings.ts` and `shared/capture-classifier.ts` are `git show 5409f3c8:apps/desktop/src/…` verbatim: the
settings as the build before IMP-153 reads and saves them, for `settings.test.ts` to go back to that build and up
again (IMP-154). Kept as files rather than read with `git show` at test time: CI checks out one commit.
