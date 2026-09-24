FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY SeamlessShare.csproj ./
RUN dotnet restore
COPY . ./
RUN dotnet publish SeamlessShare.csproj -c Release --no-restore -o /out

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=build /out ./
ENV ASPNETCORE_URLS=http://+:8080 \
    SHARE_DATA_DIR=/app/data \
    SHARE_TRUST_PROXY=true
EXPOSE 8080
ENTRYPOINT ["dotnet", "SeamlessShare.dll"]
