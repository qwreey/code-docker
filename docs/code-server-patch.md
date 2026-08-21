# 코드 서버 패치

폰트나 css, js 를 커스텀으로 로드하고 싶은 경우 `/code/.local/share/code-docker/code/patch` 폴더를 만들어 안에 css, js 를 만들어줄 수 있습니다.

![image](https://github.com/user-attachments/assets/1cd9f7ad-d510-4d89-aa64-15524f68b4c5)

CSS 에서는 에셋을 상대 경로로 불러올 수 있습니다. 폰트를 불러오고싶은 경우 아래와 같은 코드를 작성하세요

```css
@font-face {
	font-family: 'KawaiiMono';
	src: url('./fonts/KawaiiMonoRegular.ttf') format('truetype');
	font-weight: 400;
	font-style: normal;
}
```

> 주의사항: patch 바로 아래에 있는 css, js 만 바로 로드됩니다. patch 안에 폴더를 만들어 파일을 넣는 경우 에셋으로 취급됩니다.

css, js 를 변경한 경우 코드 터미널에서 `restart` 를 입력하고, 윈도우 리로드가 뜰 때 리로드를 해주면 적용된 code-server 를 보실 수 있습니다.

## PWA 이름과 아이콘

앱의 이름은 `PWA_NAME`, `PWA_SHORT_NAME` 환경변수를 변경하여 설정할 수 있습니다. `.env` 파일에 추가하세요 (`example-env` 참고).

아이콘을 추가하려면 patch 디렉터리에 `icons/pwa-icon-512.png` 와 `icons/pwa-icon-192.png` 를 크기에 맞게 생성하세요.

ffmpeg 를 통해 특정 이미지를 크기를 변경하여 아이콘으로 적용하려면 다음을 수행하세요
```sh
IMAGE=./myimage.png
PATCH_FOLDER=/code/.local/share/code-docker/code/patch

mkdir -p "$PATCH_FOLDER/icons"
ffmpeg -i "$IMAGE" -vf scale=512:512 "$PATCH_FOLDER/icons/pwa-icon-512.png"
ffmpeg -i "$IMAGE" -vf scale=192:192 "$PATCH_FOLDER/icons/pwa-icon-192.png"
```

## window-appicon.{png,webp,jpg,jpeg,gif}

추가적으로, 만약 창 왼쪽 위의 타이틀바 아이콘을 변경하려면 `window-appicon.*` 파일을 patch 디렉터리에 생성하여 원하는 이미지로 변경할 수 있습니다.
