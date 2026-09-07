// 계정이 없어도 Argon2 검증을 거쳐 빠른 실패로 존재 여부가 드러나는 것을 줄인다.
// 무작위 값으로 만든 비교 전용 해시이며 실제 계정에는 저장하지 않는다.
export const MISSING_USER_PASSWORD_HASH =
  '$argon2id$v=19$m=65536,p=4,t=3$kTWM6+kUR5OE2n8VhX69EA$+GS0hW+JoVG8aFGxX+5n9BOXRYuA9JcJ01sFCOf45NA';
