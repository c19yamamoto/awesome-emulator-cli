# Changelog

## [0.6.3](https://github.com/c19yamamoto/awesome-emulator-cli/compare/v0.6.2...v0.6.3) (2026-11-20)


### Maintenance

* **emulator-version:** update AWS Emulator to v1.0.544 ([#68](https://github.com/c19yamamoto/awesome-emulator-cli/issues/68)) ([b63e51b](https://github.com/c19yamamoto/awesome-emulator-cli/commit/b63e51bca3e911555f01a55c842ee0dfc069f92e))

## [0.6.2](https://github.com/c19yamamoto/awesome-emulator-cli/compare/v0.6.1...v0.6.2) (2026-11-20)


### Maintenance

* **npm:** add search keywords ([#64](https://github.com/c19yamamoto/awesome-emulator-cli/issues/64)) ([1646cff](https://github.com/c19yamamoto/awesome-emulator-cli/commit/1646cffac6ac7936827bfafe5f8352d760308720))

## [0.6.1](https://github.com/c19yamamoto/awesome-emulator-cli/compare/v0.6.0...v0.6.1) (2026-11-20)


### Performance Improvements

* avoid redundant package builds ([#61](https://github.com/c19yamamoto/awesome-emulator-cli/issues/61)) ([b44dd9f](https://github.com/c19yamamoto/awesome-emulator-cli/commit/b44dd9f5fcf19e0fffe80f4d3c70b229ea4c2346))

## [0.6.0](https://github.com/c19yamamoto/awesome-emulator-cli/compare/v0.5.1...v0.6.0) (2026-11-20)


### Features

* **cli:** expose emulator credentials and TLS paths ([#57](https://github.com/c19yamamoto/awesome-emulator-cli/issues/57)) ([522f497](https://github.com/c19yamamoto/awesome-emulator-cli/commit/522f497cb63ebe802e280b65a3a7b938eebb6c79))
* **cli:** support a configurable emulator state directory ([#56](https://github.com/c19yamamoto/awesome-emulator-cli/issues/56)) ([0e71e37](https://github.com/c19yamamoto/awesome-emulator-cli/commit/0e71e37c6027dad8e5acd382718a7eb43060d928))


### Bug Fixes

* **cli:** isolate nested npx package resolution ([#60](https://github.com/c19yamamoto/awesome-emulator-cli/issues/60)) ([9acf7cd](https://github.com/c19yamamoto/awesome-emulator-cli/commit/9acf7cda6ec5c22beb2fd5c5a488f243a3e05689))

## [0.5.1](https://github.com/c19yamamoto/awesome-emulator-cli/compare/v0.5.0...v0.5.1) (2026-11-20)


### Bug Fixes

* **deps:** secure SDK smoke dependencies ([#48](https://github.com/c19yamamoto/awesome-emulator-cli/issues/48)) ([1f66193](https://github.com/c19yamamoto/awesome-emulator-cli/commit/1f66193ef285a8e74af8958a4e9717d90b1867a8))


### Maintenance

* **deps:** bump actions/cache from 4.3.0 to 6.1.0 in the all-github-actions group ([#51](https://github.com/c19yamamoto/awesome-emulator-cli/issues/51)) ([c7e8c59](https://github.com/c19yamamoto/awesome-emulator-cli/commit/c7e8c595259112980506b77b6e4e7882b33f8374))
* **deps:** bump the all-sdk-smoke-gomod group in /examples/sdk-smoke/go with 2 updates ([#53](https://github.com/c19yamamoto/awesome-emulator-cli/issues/53)) ([56bf750](https://github.com/c19yamamoto/awesome-emulator-cli/commit/56bf75046943a0f4031f38ae3600db900d765496))
* **deps:** bump the all-sdk-smoke-maven group in /examples/sdk-smoke/java with 2 updates ([#50](https://github.com/c19yamamoto/awesome-emulator-cli/issues/50)) ([c835e25](https://github.com/c19yamamoto/awesome-emulator-cli/commit/c835e25b20b220e545e2b9f116c79c796ca789a8))
* **deps:** the all-sdk-smoke-nuget group with 1 update ([#52](https://github.com/c19yamamoto/awesome-emulator-cli/issues/52)) ([36fa55f](https://github.com/c19yamamoto/awesome-emulator-cli/commit/36fa55f5fdfc47a78472df01547e5a8ef8f3f0ff))

## [0.5.0](https://github.com/c19yamamoto/awesome-emulator-cli/compare/v0.4.0...v0.5.0) (2026-11-20)


### Features

* add emulator initialization hook ([#45](https://github.com/c19yamamoto/awesome-emulator-cli/issues/45)) ([5aa2670](https://github.com/c19yamamoto/awesome-emulator-cli/commit/5aa2670d1a05e723f28463f320b934ae576d7247))
* add managed emulator sessions ([#44](https://github.com/c19yamamoto/awesome-emulator-cli/issues/44)) ([ceb1373](https://github.com/c19yamamoto/awesome-emulator-cli/commit/ceb137345e946e7e953974aef7ca4efd0cd52066))

## [0.4.0](https://github.com/c19yamamoto/awesome-emulator-cli/compare/v0.3.0...v0.4.0) (2026-11-20)


### Features

* allow setting child command region ([#41](https://github.com/c19yamamoto/awesome-emulator-cli/issues/41)) ([29fcd18](https://github.com/c19yamamoto/awesome-emulator-cli/commit/29fcd18b1cfd4b1548d248c8278a20555e616784))
* support AWS SDKs in non-Node CI projects ([#40](https://github.com/c19yamamoto/awesome-emulator-cli/issues/40)) ([9dfd01a](https://github.com/c19yamamoto/awesome-emulator-cli/commit/9dfd01a6dfc9df411ebc0019c0f0eb362660b69e))


### Bug Fixes

* **release:** publish emulator version updates as patch releases ([#37](https://github.com/c19yamamoto/awesome-emulator-cli/issues/37)) ([fdf8b04](https://github.com/c19yamamoto/awesome-emulator-cli/commit/fdf8b04f34feb08b45701831af214e6ab8e2571b))

## [0.3.0](https://github.com/c19yamamoto/awesome-emulator-cli/compare/v0.2.0...v0.3.0) (2026-11-20)


### Features

* add emulator image preparation command ([#30](https://github.com/c19yamamoto/awesome-emulator-cli/issues/30)) ([37248ea](https://github.com/c19yamamoto/awesome-emulator-cli/commit/37248ea437cd4c46f179d246b20e48e9c7302c5d))


### Bug Fixes

* **ci:** repair AWS Emulator version updater workflow ([#34](https://github.com/c19yamamoto/awesome-emulator-cli/issues/34)) ([01133a5](https://github.com/c19yamamoto/awesome-emulator-cli/commit/01133a589117095c36c0eaed010e777b562e27f9))


### Performance Improvements

* **ci:** cache emulator image between runs ([#31](https://github.com/c19yamamoto/awesome-emulator-cli/issues/31)) ([3a96963](https://github.com/c19yamamoto/awesome-emulator-cli/commit/3a96963029c8c465d02c8f67c370019452c87ee2))
* reduce redundant CI builds ([#32](https://github.com/c19yamamoto/awesome-emulator-cli/issues/32)) ([7604bf5](https://github.com/c19yamamoto/awesome-emulator-cli/commit/7604bf5cb13cfe4c7aabec126b03f68bf8acdfc7))

## [0.2.0](https://github.com/c19yamamoto/awesome-emulator-cli/compare/v0.1.2...v0.2.0) (2026-11-20)


### Features

* automate AWS Emulator version updates ([#17](https://github.com/c19yamamoto/awesome-emulator-cli/issues/17)) ([b6d0940](https://github.com/c19yamamoto/awesome-emulator-cli/commit/b6d094056c7319f6d3687d4abad50dfbeecb8d67))

## [0.1.2](https://github.com/c19yamamoto/awesome-emulator-cli/compare/v0.1.1...v0.1.2) (2026-11-19)


### Bug Fixes

* disable shell parsing for child commands by default ([#21](https://github.com/c19yamamoto/awesome-emulator-cli/issues/21)) ([d0a0abf](https://github.com/c19yamamoto/awesome-emulator-cli/commit/d0a0abfd33bef6dee2de845f66e64b2e6a7c85de))
* key emulator image cache by build definition ([#20](https://github.com/c19yamamoto/awesome-emulator-cli/issues/20)) ([afb052d](https://github.com/c19yamamoto/awesome-emulator-cli/commit/afb052df4e8ef937cbdb9cfce770b2e43d694bd8))
* reject RPM signatures from unrelated keys ([#18](https://github.com/c19yamamoto/awesome-emulator-cli/issues/18)) ([aa6f6c6](https://github.com/c19yamamoto/awesome-emulator-cli/commit/aa6f6c6356e0550b887d154a567e0b522960ec28))

## [0.1.1](https://github.com/c19yamamoto/awesome-emulator-cli/compare/v0.1.0...v0.1.1) (2026-11-19)


### Bug Fixes

* use full GPG for AL2023 package verification ([#1](https://github.com/c19yamamoto/awesome-emulator-cli/issues/1)) ([725b1c5](https://github.com/c19yamamoto/awesome-emulator-cli/commit/725b1c520dbe9ac7761a8edae4a949a5040ab93e))
