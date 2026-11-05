# 무료 Google 로그인과 동기화 연결

운영 조건은 **GitHub Pages + Supabase Free + Google 로그인**이다. 결제 수단 등록, Pro 업그레이드, 유료 애드온, 이메일 발송 서비스, 도메인 구매는 필요하지 않다. 무료 한도에 도달하면 제한을 안내하며 유료로 전환하지 않는다. Supabase Free 프로젝트는 비활성 상태가 오래 지속되면 휴면될 수 있다.

## 1. Supabase Free 프로젝트

무료 조직에서 `fridge-grocery` 프로젝트를 만든다. 데이터베이스 비밀번호는 소유자가 직접 설정하고 보관한다. Data API는 켜되 새 테이블 자동 공개는 끄고 RLS는 켠다. 결제 정보는 입력하지 않는다.

SQL Editor에서 이 폴더의 `schema.sql`을 실행한다. 이 스크립트는 `fridge_accounts` 테이블과 `save_fridge_state` 함수만 만든다. 본인 계정은 자기 행만 읽을 수 있고, 쓰기는 인증 사용자 ID와 기대 버전을 검사하는 함수로만 허용한다.

## 2. Google 로그인 설정

Google Cloud에서 이 앱 전용 프로젝트와 Google Auth Platform 설정을 준비한다. 로그인에는 `openid`, `email`, `profile`만 사용한다. Gmail 읽기, Drive 접근 등은 요청하지 않는다. 과금 계정을 연결하거나 유료 API를 켜지 않는다.

웹 애플리케이션 OAuth 클라이언트의 승인된 리디렉션 URI에 Supabase Google Provider 화면에 표시된 callback URL을 정확히 등록한다. Supabase Authentication → Sign In / Providers → Google에 클라이언트 ID와 Secret을 설정한다. 새 Secret의 생성·입력은 소유자가 직접 처리한다. Secret은 Supabase 관리 화면에만 넣고 GitHub, 웹 파일, 채팅에 붙이지 않는다.

Audience가 Testing이면 사용할 Google 계정을 테스트 사용자에 추가해야 한다. 일반 사용자에게 공개하려면 Google의 게시·브랜딩 요구를 충족한 후 Production으로 전환한다. 개인정보 안내와 서비스 정보도 실제로 제공해야 한다. Google 기본 로그인만을 위해 결제 정보를 등록할 필요는 없다.

## 3. 앱 주소와 공개 설정

Supabase Authentication → URL Configuration의 Site URL과 허용 Redirect URL에 다음 주소를 등록한다.

`https://userb2.github.io/fridge-grocery/`

로컬 확인이 필요하면 사용 중인 로컬 서버의 정확한 주소도 추가한다. 전체 도메인 wildcard를 쓰지 않는다.

`cloud-config.js`에는 Supabase 프로젝트 URL과 publishable key(또는 legacy anon key)만 넣는다. 비밀번호, service-role key, Google Client Secret은 넣지 않는다. 설정이 비어 있으면 앱은 로컬 모드로 동작한다.

## 4. 실제 연결 확인

1. Google로 로그인한 뒤 계정이 비어 있으면 기존 프로필을 직접 선택해 가져온다. 기존 브라우저 저장값은 보존한다.
2. 다른 브라우저에서 같은 Google 계정으로 로그인하고 같은 기록이 보이는지 확인한다.
3. 재료·장보기·구매 내역을 바꿔 다른 기기에 반영되는지 확인한다.
4. 다른 Google 계정에서는 첫 계정의 기록이 보이지 않는지 확인한다.
5. 두 기기에서 같은 기록을 동시에 수정해 뒤늦은 저장이 거절되는지 확인한다. 입력 보관 파일을 받은 뒤 최신 기록을 불러올 수 있다.
6. 로그아웃하면 계정 기록을 숨기고 해당 기기의 로컬 프로필로 돌아오는지 확인한다.

온라인 저장은 서버의 응답이 확인된 뒤 완료로 표시한다. 네트워크 오류로 결과가 불명확하면 마지막 저장 식별자를 조회하고, 확인할 수 없으면 입력을 유지하며 추가 저장을 막는다. 계정 기록은 기기별 캐시로 읽을 수 있지만 오프라인 편집 대기열은 제공하지 않는다.

## 검증 명령

`npm ci` 후 `npm test`를 실행한다. 배포용 실행에는 설치나 빌드가 필요하지 않으며 테스트용 의존성만 설치된다. 데이터베이스 권한 검증은 PGlite의 실제 PostgreSQL 역할과 SQL로 실행한다. 외부 Google/Supabase 설정과 실제 두 기기 로그인 확인은 별도로 해야 한다.

공식 안내: [Supabase Free와 비용](https://supabase.com/docs/guides/platform/cost-control), [Google 로그인](https://supabase.com/docs/guides/auth/social-sign-in/auth-google), [행 단위 접근 제어](https://supabase.com/docs/guides/database/postgres/row-level-security).
