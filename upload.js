(() => {
  const bridge = window.videoAppBridge;
  const config = window.SHORTS_SUPABASE_CONFIG;
  const dialog = document.querySelector("#upload-dialog");
  const form = document.querySelector("#video-upload-form");
  const openButton = document.querySelector("#upload-open-button");
  const closeButton = document.querySelector("#upload-close-button");
  const titleInput = document.querySelector("#upload-title");
  const typeInput = document.querySelector("#upload-type");
  const fileInput = document.querySelector("#upload-file");
  const submitButton = document.querySelector("#upload-submit-button");
  const progressArea = document.querySelector("#upload-progress-area");
  const progress = document.querySelector("#upload-progress");
  const progressLabel = document.querySelector("#upload-progress-label");
  const status = document.querySelector("#upload-status");
  const compressHelp = document.querySelector("#upload-compress-help");
  const maxFileSize = 50 * 1024 * 1024;
  let isUploading = false;

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.dataset.error = String(isError);
  }

  function setProgress(value) {
    const percent = Math.max(0, Math.min(100, Math.round(value)));
    progress.value = percent;
    progressLabel.textContent = `${percent}%`;
    progress.setAttribute("aria-label", `Uploadvoortgang ${percent}%`);
  }

  function setBusy(busy) {
    isUploading = busy;
    submitButton.disabled = busy;
    closeButton.disabled = busy;
    titleInput.disabled = busy;
    typeInput.disabled = busy;
    fileInput.disabled = busy;
  }

  function parseResponseText(text) {
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  function uploadToSupabase({ accessToken, uploadSessionId, file }) {
    return new Promise((resolve, reject) => {
      const url = new URL(
        "/functions/v1/create-github-release",
        config.url,
      );
      url.searchParams.set("upload_session_id", uploadSessionId);
      const request = new XMLHttpRequest();
      request.open("POST", url.toString());
      request.setRequestHeader("Authorization", `Bearer ${accessToken}`);
      request.setRequestHeader("apikey", config.anonKey);
      request.setRequestHeader("Content-Type", "video/mp4");
      request.upload.addEventListener("progress", (event) => {
        if (!event.lengthComputable) return;
        setProgress(Math.min(99, (event.loaded / event.total) * 100));
        setStatus("Supabase stuurt je video rechtstreeks door naar GitHub...");
      });
      request.addEventListener("load", () => {
        const response = parseResponseText(request.responseText);
        if (request.status < 200 || request.status >= 300) {
          if (request.status === 413) {
            compressHelp.hidden = false;
          }
          reject(
            new Error(
              response.error ||
                `Upload mislukt (HTTP ${request.status}). Controleer of het bestand maximaal 50 MB is.`,
            ),
          );
          return;
        }
        resolve(response);
      });
      request.addEventListener("error", () => {
        reject(new Error("Verbinding met Supabase is mislukt."));
      });
      request.addEventListener("abort", () => {
        reject(new Error("De verbinding tijdens het uploaden is afgebroken."));
      });
      request.send(file);
    });
  }

  async function handleUpload(event) {
    event.preventDefault();
    if (!bridge?.supabaseClient) {
      setStatus("Supabase is niet beschikbaar. Probeer het later opnieuw.", true);
      return;
    }

    const user = bridge.getCurrentUser();
    if (!user) {
      dialog.close();
      bridge.openAccount();
      return;
    }

    const title = titleInput.value.trim();
    const type = typeInput.value;
    const file = fileInput.files?.[0];
    if (!title || title.length > 120) {
      setStatus("Vul een titel van maximaal 120 tekens in.", true);
      return;
    }
    if (!["video", "short"].includes(type)) {
      setStatus("Kies Video of Short.", true);
      return;
    }
    if (!file || !file.name.toLowerCase().endsWith(".mp4")) {
      setStatus("Kies een .mp4-bestand.", true);
      return;
    }
    if (file.type && file.type !== "video/mp4") {
      setStatus("Het gekozen bestand is geen MP4-video.", true);
      return;
    }
    if (file.size === 0) {
      setStatus("Kies een MP4-bestand dat niet leeg is.", true);
      return;
    }
    if (file.size > maxFileSize) {
      compressHelp.hidden = false;
      setStatus("Het bestand is groter dan de uploadlimiet van 50 MB.", true);
      return;
    }
    compressHelp.hidden = true;

    setBusy(true);
    progressArea.hidden = false;
    setProgress(0);
    setStatus("Release wordt voorbereid...");
    try {
      const { data: sessionData, error: sessionError } =
        await bridge.supabaseClient.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (sessionError || !accessToken) {
        throw new Error("Je sessie is verlopen. Log opnieuw in.");
      }

      const { data: releaseData, error: releaseError } =
        await bridge.supabaseClient.functions.invoke("create-github-release", {
          body: { title },
        });
      if (releaseError || releaseData?.error) {
        throw new Error(
          releaseData?.error ||
            releaseError?.message ||
            "De GitHub Release kon niet worden aangemaakt.",
        );
      }
      if (!releaseData?.upload_session_id) {
        throw new Error("De release-service gaf geen geldige upload-sessie terug.");
      }

      setStatus("Supabase stuurt de video veilig door naar GitHub...");
      const uploaded = await uploadToSupabase({
        accessToken,
        uploadSessionId: releaseData.upload_session_id,
        file,
      });
      if (!uploaded?.video_url) {
        throw new Error("GitHub heeft geen geldige downloadlink teruggegeven.");
      }

      setStatus("Video wordt aan je kanaal toegevoegd...");
      const { data: savedVideo, error: saveError } = await bridge.supabaseClient
        .from("videos")
        .insert({
          title: releaseData.title || title,
          video_url: uploaded.video_url,
          type,
          user_id: user.id,
          author_name: bridge.getAuthorName(),
        })
        .select("id, title, video_url, type, author_name, user_id")
        .single();
      if (saveError) {
        throw new Error(
          `De video is naar GitHub geüpload, maar opslaan in Supabase is mislukt: ${saveError.message}`,
        );
      }

      bridge.renderUploadedVideo(savedVideo);
      setProgress(100);
      setStatus("Upload voltooid. Je video staat nu op je kanaal.");
      form.reset();
    } catch (error) {
      setStatus(error.message || "Uploaden is mislukt. Probeer het opnieuw.", true);
    } finally {
      setBusy(false);
    }
  }

  openButton.addEventListener("click", () => {
    if (!bridge?.getCurrentUser()) {
      bridge?.openAccount();
      return;
    }
    form.reset();
    compressHelp.hidden = true;
    progressArea.hidden = true;
    setProgress(0);
    setStatus("");
    dialog.showModal();
    titleInput.focus();
  });

  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    const tooLarge = Boolean(file && file.size > maxFileSize);
    compressHelp.hidden = !tooLarge;
    if (tooLarge) {
      setStatus("Het bestand is groter dan de uploadlimiet van 50 MB.", true);
    } else {
      setStatus("");
    }
  });

  closeButton.addEventListener("click", () => {
    if (!isUploading) dialog.close();
  });

  dialog.addEventListener("cancel", (event) => {
    if (isUploading) event.preventDefault();
  });

  form.addEventListener("submit", handleUpload);
  window.videoUploadController = {
    setUser(user) {
      openButton.hidden = false;
      if (!user && dialog.open) dialog.close();
    },
  };
})();
